const WebSocket = require("ws");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
dotenv.config();

const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgram = createClient(deepgramApiKey);

// Helper function for better logging with timestamps
function logWithTimestamp(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

const wss = new WebSocket.Server({ port: 8080 });

wss.on("connection", (ws) => {
  logWithTimestamp("Frontend client connected");
  
  let messageCounter = 0;
  let audioBytesSent = 0;

  logWithTimestamp("Initializing Deepgram connection...");
  const dgConnection = deepgram.listen.live({
    smart_format: true,
    model: "nova-2",
    language: "en-GB",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1
  });
  

  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    logWithTimestamp("Connected to Deepgram successfully");

    dgConnection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0]?.transcript;
      logWithTimestamp(`Received Deepgram response: ${JSON.stringify(data.is_final ? 'FINAL' : 'INTERIM')}`);
      
      if (transcript) {
        logWithTimestamp(`Transcript received: "${transcript}"`); 
        try {
          logWithTimestamp("Sending transcript to frontend client");
          ws.send(JSON.stringify({ transcript }));
          logWithTimestamp("Transcript sent to frontend successfully");
        } catch (error) {
          logWithTimestamp(`Error sending transcript to frontend: ${error.message}`);
        }
      } else {
        logWithTimestamp("Received empty transcript from Deepgram");
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Close, () => {
      logWithTimestamp("Deepgram connection closed");
    });
    
    dgConnection.on(LiveTranscriptionEvents.Error, (error) => {
      logWithTimestamp(`Deepgram error: ${error}`);
    });
  });

  ws.on("message", (message) => {
    messageCounter++;
    audioBytesSent += message.length;
    logWithTimestamp(`[${messageCounter}] Received audio chunk from frontend: ${message.length} bytes (total: ${audioBytesSent} bytes)`);
    
    if (Buffer.isBuffer(message)) {
      try {
        logWithTimestamp(`[${messageCounter}] Forwarding audio chunk to Deepgram: ${message.length} bytes`);
        dgConnection.send(message);
        logWithTimestamp(`[${messageCounter}] Audio chunk sent to Deepgram successfully`);
      } catch (error) {
        logWithTimestamp(`[${messageCounter}] Error sending audio to Deepgram: ${error.message}`);
      }
    } else {
      logWithTimestamp(`[${messageCounter}] Received non-buffer message from frontend: ${typeof message}`);
    }
  });
  

  ws.on("close", () => {
    logWithTimestamp("Frontend client disconnected");
    logWithTimestamp(`Connection summary: Processed ${messageCounter} audio chunks, ${audioBytesSent} total bytes`);
    logWithTimestamp("Closing Deepgram connection...");
    dgConnection.finish();
    logWithTimestamp("Deepgram connection finished");
  });
  
  ws.on("error", (error) => {
    logWithTimestamp(`WebSocket error with frontend client: ${error.message}`);
  });
});

logWithTimestamp("WebSocket proxy server started and listening on ws://localhost:8080");
