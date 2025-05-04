document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const screenShareBtn = document.getElementById('screenShareBtn');
    const stopBtn = document.getElementById('stopBtn');
    const transcriptionElement = document.getElementById('transcription');
    const statusElement = document.getElementById('status');

    let socket = null;
    let audioStream = null;
    let audioContext = null;
    let processorInterval = null;
    let screenStream = null;
    let screenVideoElement = null;
    let isScreenSharing = false;
    let readyToSendAudio = false;

    function updateStatus(connected, mode = 'microphone') {
        if (connected) {
            statusElement.textContent = `Connected (${mode} active)`;
            statusElement.classList.add('connected');
            statusElement.classList.remove('disconnected');
            startBtn.disabled = true;
            screenShareBtn.disabled = true;
            stopBtn.disabled = false;
        } else {
            statusElement.textContent = 'Disconnected';
            statusElement.classList.add('disconnected');
            statusElement.classList.remove('connected');
            startBtn.disabled = false;
            screenShareBtn.disabled = false;
            stopBtn.disabled = true;
            isScreenSharing = false;
        }
    }

    async function startMicrophone() {
        try {
            console.log('Requesting microphone access...');
            // Request microphone access
            audioStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 16000
                }
            });
            console.log('Microphone access granted');
            
            // Create audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            console.log('AudioContext created with sample rate:', audioContext.sampleRate);
            
            // Resume the AudioContext (required in some browsers)
            if (audioContext.state === 'suspended') {
                await audioContext.resume();
                console.log('AudioContext resumed from suspended state');
            }
            
            const source = audioContext.createMediaStreamSource(audioStream);
            console.log('Media stream source created');
            
            // Use AnalyserNode for audio processing instead of deprecated ScriptProcessor
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 4096;
            source.connect(analyser);
            console.log('Analyser connected to source');
            
            // Setup regular sampling of audio data
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            console.log('Buffer created with length:', bufferLength);
            
            // Debug counter for checking if audio is being processed
            let audioPacketCounter = 0;
            const logInterval = 100; // Log every 100 packets
            
            function processAudio() {
                if (audioContext) {
                    // Get audio data
                    analyser.getFloatTimeDomainData(dataArray);
                    
                    // Convert float32 audio data to 16-bit PCM
                    const pcmData = convertFloat32ToInt16(dataArray);
                    
                    // Periodically log audio data for debugging
                    audioPacketCounter++;
                    if (audioPacketCounter % logInterval === 0) {
                        console.log(`Sending audio packet #${audioPacketCounter}, size: ${pcmData.byteLength} bytes`);
                        // Log a small sample of the audio data to verify it's not all zeros
                        const int16View = new Int16Array(pcmData.slice(0, 16));
                        console.log('Audio sample (first 8 values):', Array.from(int16View).slice(0, 8));
                    }
                    
                    // Only send audio if backend is ready
                    if (readyToSendAudio && socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(pcmData);
                    }
                }
            }
            
            // Start periodic audio processing
            processorInterval = setInterval(processAudio, 100);
            console.log('Audio processing started');
            
            return true;
        } catch (error) {
            console.error('Error starting microphone:', error);
            if (error.name === 'NotAllowedError') {
                alert('Microphone access was denied. Please allow microphone access to use this application.');
            } else {
                alert(`Error starting microphone: ${error.message}`);
            }
            return false;
        }
    }

    async function startScreenShare() {
        try {
            console.log('Requesting screen sharing access...');
            
            // Create a CaptureController instance for focus behavior if supported
            const captureController = 'CaptureController' in window 
                ? new window.CaptureController() 
                : null;

            // Media stream options
            const displayMediaOptions = {
                video: {
                    cursor: "always",
                    displaySurface: "browser",
                    monitorTypeSurfaces: "exclude"
                },
                audio: true  // Request audio from the screen share
            };

            // Add controller option if CaptureController is supported
            if (captureController) {
                displayMediaOptions.controller = captureController;
            }

            // Request screen sharing access
            screenStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);

            // Set focus behavior if supported
            if (captureController && 'setFocusBehavior' in captureController) {
                try {
                    await captureController.setFocusBehavior('no-focus-change');
                } catch (err) {
                    console.error("Error setting focus behavior:", err);
                }
            }

            // Handle when user stops screen sharing via browser UI
            screenStream.getVideoTracks()[0].onended = () => {
                console.log('Screen sharing stopped by user');
                disconnectWebSocket();
            };

            // Create video element to display screen share (optional, can be hidden)
            screenVideoElement = document.createElement('video');
            screenVideoElement.srcObject = screenStream;
            screenVideoElement.muted = true; // Avoid feedback loop
            screenVideoElement.style.width = '200px';
            screenVideoElement.style.position = 'fixed';
            screenVideoElement.style.bottom = '10px';
            screenVideoElement.style.right = '10px';
            screenVideoElement.style.zIndex = '1000';
            screenVideoElement.style.borderRadius = '5px';
            screenVideoElement.style.border = '1px solid #ccc';
            document.body.appendChild(screenVideoElement);
            screenVideoElement.play().catch(err => console.error('Error playing screen preview:', err));
            
            // Get audio track from screen share
            const audioTracks = screenStream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('No audio track found in screen share');
                alert('No audio detected from screen share. Please ensure you selected to share audio.');
                // Stop screen sharing and clean up
                stopMicrophone();
                return false;
            }
            
            // Create audio context for processing the screen share audio
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 16000
            });
            
            // Create a MediaStreamAudioSourceNode
            audioStream = new MediaStream([audioTracks[0]]);
            const source = audioContext.createMediaStreamSource(audioStream);
            
            // Create an analyzer node
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 4096;
            source.connect(analyser);
            
            // Setup regular sampling of audio data
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            
            // Initialize audio packet counter for logging
            let audioPacketCounter = 0;
            const logInterval = 100; // Log every 100 packets
            
            // Start processing audio data
            processorInterval = setInterval(() => {
                if (!audioContext) return;
                
                // Get audio data
                analyser.getFloatTimeDomainData(dataArray);
                
                // Convert to PCM
                const pcmData = convertFloat32ToInt16(dataArray);
                
                // Periodically log audio data for debugging
                audioPacketCounter++;
                if (audioPacketCounter % logInterval === 0) {
                    console.log(`Sending screen audio packet #${audioPacketCounter}, size: ${pcmData.byteLength} bytes`);
                    // Log a small sample of the audio data 
                    const int16View = new Int16Array(pcmData.slice(0, 16));
                    console.log('Audio sample (first 8 values):', Array.from(int16View).slice(0, 8));
                }
                
                // Send to server if ready
                if (readyToSendAudio && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(pcmData);
                }
            }, 100); // Process audio every 100ms
            
            isScreenSharing = true;
            console.log('Screen sharing started successfully');
            
            return true;
        } catch (error) {
            console.error('Error starting screen share:', error);
            if (error.name === 'NotAllowedError') {
                alert('Screen sharing permission denied. Please allow screen sharing to use this feature.');
            } else {
                alert(`Failed to start screen sharing: ${error.message}`);
            }
            return false;
        }
    }

    function stopMicrophone() {
        console.log('Stopping all audio sources...');

        // Stop any processor interval
        if (processorInterval) {
            clearInterval(processorInterval);
            processorInterval = null;
            console.log('Audio processor interval cleared');
        }

        // Close audioContext
        if (audioContext) {
            audioContext.close().then(() => {
                console.log('AudioContext closed');
            }).catch(err => {
                console.error('Error closing AudioContext:', err);
            });
            audioContext = null;
        }

        // Stop audio stream
        if (audioStream) {
            audioStream.getTracks().forEach(track => {
                track.stop();
                console.log('Audio track stopped');
            });
            audioStream = null;
        }
        
        // Stop screen sharing if active
        if (screenStream) {
            screenStream.getTracks().forEach(track => {
                track.stop();
                console.log('Screen sharing track stopped');
            });
            screenStream = null;
            
            // Remove video element if it exists
            if (screenVideoElement) {
                if (screenVideoElement.parentNode) {
                    screenVideoElement.parentNode.removeChild(screenVideoElement);
                }
                screenVideoElement = null;
            }
        }
        
        console.log('All media stopped successfully');
    }

    function convertFloat32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        
        // Convert Float32 to Int16
        for (let i = 0; i < float32Array.length; i++) {
            // Scale float32 to int16 range and clamp to prevent overflow
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            // Convert -1->1 to -32768->32767 and round to nearest integer
            int16Array[i] = s < 0 
                ? Math.floor(s * 0x8000) 
                : Math.floor(s * 0x7FFF);
        }
        
        return int16Array.buffer;
    }

    function connectWebSocket(mode = 'microphone') {
        // Close any existing socket
        if (socket) {
            socket.close();
        }
        
        // Connect to WebSocket server
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = 3001; // Make sure this matches your WebSocket server port
        const wsUrl = `${protocol}//${host}:${port}/websocket`;
        
        try {
            console.log(`Connecting to WebSocket server at ${wsUrl}`);
            socket = new WebSocket(wsUrl);
            
            // Reset the ready state
            readyToSendAudio = false;
            
            socket.onopen = async () => {
                console.log('WebSocket connection established');
                
                // Check if browser supports required audio APIs
                if (!window.AudioContext && !window.webkitAudioContext) {
                    console.error('AudioContext not supported in this browser');
                    alert('Your browser does not support the required audio features. Please try a different browser.');
                    socket.close();
                    return;
                }
                
                // Start appropriate audio capture method
                let success = false;
                if (mode === 'screenShare') {
                    // Tell the server we're starting screen sharing
                    socket.send(JSON.stringify({ action: 'start_screenshare' }));
                    
                    // Start screen sharing
                    success = await startScreenShare();
                    if (success) {
                        updateStatus(true, 'screen sharing');
                    }
                } else {
                    // Default to microphone
                    socket.send(JSON.stringify({ action: 'start_microphone' }));
                    
                    // Start microphone
                    success = await startMicrophone();
                    if (success) {
                        updateStatus(true, 'microphone');
                    }
                }
                
                if (!success) {
                    socket.close();
                    updateStatus(false);
                }
            };
            
            socket.onmessage = (event) => {
                try {
                    // Only process JSON messages, audio data is binary
                    if (typeof event.data === 'string') {
                        const data = JSON.parse(event.data);
                        
                        if (data.type === 'status' && data.message === 'Ready to receive audio') {
                            readyToSendAudio = true;
                            console.log('Audio transmission status: READY (Deepgram connected)');
                            
                            // Show status message to the user
                            const statusMsg = document.createElement('p');
                            statusMsg.classList.add('status-message');
                            statusMsg.textContent = isScreenSharing 
                                ? 'Screen sharing active - audio is being captured!' 
                                : 'Microphone active - speak now!';
                            transcriptionElement.appendChild(statusMsg);
                            transcriptionElement.scrollTop = transcriptionElement.scrollHeight;
                        } else if (data.type === 'transcript') {
                            // Extract the transcript from the Deepgram response
                            if (data.data && data.data.channel && data.data.channel.alternatives && data.data.channel.alternatives.length > 0) {
                                const transcript = data.data.channel.alternatives[0].transcript;
                                
                                if (transcript) {
                                    // Add the new transcript to the display
                                    const newTranscriptElement = document.createElement('p');
                                    newTranscriptElement.textContent = transcript;
                                    transcriptionElement.appendChild(newTranscriptElement);
                                    
                                    // Auto-scroll to the bottom
                                    transcriptionElement.scrollTop = transcriptionElement.scrollHeight;
                                }
                            }
                        } else if (data.type === 'error') {
                            console.error('Error from server:', data.message);
                            alert(`Error: ${data.message}`);
                        }
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            };
            
            socket.onclose = () => {
                console.log('WebSocket connection closed');
                stopMicrophone();
                updateStatus(false);
            };
            
            socket.onerror = (error) => {
                console.error('WebSocket error:', error);
                stopMicrophone();
                updateStatus(false);
            };
            
        } catch (error) {
            console.error('Error connecting to WebSocket:', error);
            alert(`Failed to connect to server: ${error.message}`);
            updateStatus(false);
        }
    }

    function disconnectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ action: 'stop' }));
            socket.close();
        }
        stopMicrophone();
        updateStatus(false);
    }

    // Add event listeners
    startBtn.addEventListener('click', () => {
        connectWebSocket('microphone');
    });
    
    screenShareBtn.addEventListener('click', () => {
        connectWebSocket('screenShare');
    });

    stopBtn.addEventListener('click', () => {
        disconnectWebSocket();
        transcriptionElement.innerHTML = '';
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        disconnectWebSocket();
    });

    // Initialize as disconnected
    updateStatus(false);
});
