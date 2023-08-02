import asyncio
import wave
import json
import os
import websockets
import uuid

# Configure Token
token = os.getenv('JWT_TOKEN', '')

# Set WebSocket endpoint
ws_endpoint = "ws://localhost:8080"

# Set wave file path
wave_file_path = "../example_call_2_channel.wav"

# Read wave file
with wave.open(wave_file_path, 'rb') as wave_file:
    params = wave_file.getparams()
    nchannels, sampwidth, framerate, nframes = params[:4]

    # Calculate the size of 100 ms chunks (in frames)
    chunk_duration_ms = 100
    chunk_size = int(framerate * chunk_duration_ms / 1000)  # size of chunks in frames
    chunk_size_bytes = chunk_size * sampwidth  # size of chunks in bytes

    # Get callId from file name
    callId = str(uuid.uuid4()) # os.path.splitext(os.path.basename(wave_file_path))[0]

    # Set transcribe parameters
    metadata = {
        "callId": callId,
        "fromNumber": "+9165551234",
        "toNumber": "+8001112222",
        "agentId": "Agent-Python",
    }

    headers = {
        "Authorization": f"Bearer {token}"
    }

    async def send_receive():
        async with websockets.connect(ws_endpoint, extra_headers=headers) as ws:
            # Send metadata as first message
            await ws.send(json.dumps(metadata))

            # Start sending audio chunks
            data = wave_file.readframes(chunk_size)
            while data:
                await ws.send(data)
                data = wave_file.readframes(chunk_size)
                # Throttle the data sending speed to real-time
                await asyncio.sleep(chunk_duration_ms / 1000.0 / 4)
                
                # Receive server messages
                try:
                    message = await asyncio.wait_for(ws.recv(), timeout=0.1)
                    print("Received message: ", message)
                except asyncio.TimeoutError:
                    # No message from the server within the timeout period
                    pass

    asyncio.run(send_receive())
