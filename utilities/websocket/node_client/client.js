const fs = require('fs');
// const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

// replace this with your JWT token:
const token = process.env.JWT_TOKEN;

// Set WebSocket endpoint
const wsEndpoint = "ws://localhost:8080";

// Set wave file path
const waveFilePath = "../example_call_2_channel.wav";

// Get callId from UUID
let callId = uuidv4();

// Read wave file
let file = fs.readFileSync(waveFilePath);
let waveData = file.slice(44); // skip header

let nchannels = 2;
let framerate = 8000; // adjust as needed
let sampwidth = 2;
//let nframes = waveData.length / nchannels / sampwidth;

// Calculate the size of 100 ms chunks (in frames)
let chunkDurationMs = 100;
let chunkSize = Math.floor(framerate * chunkDurationMs / 1000);  // size of chunks in frames
let chunkSizeBytes = chunkSize * sampwidth * nchannels;  // size of chunks in bytes

let ws = new WebSocket(wsEndpoint, {
    headers: {
        Authorization: `Bearer ${token}`
    }
});

ws.on('open', function open() {
    // Send metadata as first message
    let metadata = {
        "callId": callId,
        "fromNumber": "+9165551234",
        "toNumber": "+8001112222",
        "agentId": "Agent-NodeJS",
    };
    ws.send(JSON.stringify(metadata));

    // Start sending audio chunks
    let byteIndex = 0;
    let intervalId = setInterval(function() {
        let data = waveData.slice(byteIndex, byteIndex + chunkSizeBytes);

        if (data.length > 0) {
            ws.send(data);
            byteIndex += chunkSizeBytes;
        } else {
            clearInterval(intervalId);
        }
    }, chunkDurationMs);

    ws.on('message', function incoming(message) {
        try {
            const jsonMessage = JSON.parse(message);
            console.log('Received message: ', JSON.stringify(jsonMessage));
        } catch (e) {
            console.error('Could not parse message as JSON: ', e);
        }
    });
});

