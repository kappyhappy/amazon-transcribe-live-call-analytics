// imports
const fs = require('fs');
const stream = require('stream');
//const uuid = require('uuid');
const WebSocket = require('ws');
var { FileWriter } = require('wav');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');


// aws-sdk
const {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  StartCallAnalyticsStreamTranscriptionCommand,
  ParticipantRole,
} = require("@aws-sdk/client-transcribe-streaming");

const { KinesisClient } = require('@aws-sdk/client-kinesis')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')


// lca-sdk
const {
  formatPath,
  sleep,
  writeS3UrlToKds,
  writeAddTranscriptSegmentEventToKds,
  writeTranscriptionSegmentToKds,
  writeCallStartEventToKds,
  writeCallEndEventToKds,
  writeCategoryEventToKds,
} = require('./lca');

// required constants
const REGION = process.env.REGION || 'us-east-1';
const USERPOOL_ID = process.env.USERPOOL_ID;
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET;

// optional constants
const { TRANSCRIBER_CALL_EVENT_TABLE_NAME } = process.env;
const RECORDING_FILE_PREFIX = formatPath(process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/');
const CALL_ANALYTICS_FILE_PREFIX = formatPath(process.env.CALL_ANALYTICS_FILE_PREFIX || 'lca-call-analytics-json/');
const RAW_FILE_PREFIX = formatPath(process.env.RAW_FILE_PREFIX || 'lca-audio-raw/');
const TCA_DATA_ACCESS_ROLE_ARN = process.env.TCA_DATA_ACCESS_ROLE_ARN || '';
const TEMP_FILE_PATH = process.env.TEMP_FILE_PATH || 'output/';
const IS_CONTENT_REDACTION_ENABLED = (process.env.IS_CONTENT_REDACTION_ENABLED || 'true') === 'true';
const TRANSCRIBE_LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE || 'en-US';
const CONTENT_REDACTION_TYPE = process.env.CONTENT_REDACTION_TYPE || 'PII';
const PII_ENTITY_TYPES = process.env.PII_ENTITY_TYPES || 'ALL';
const CUSTOM_VOCABULARY_NAME = process.env.CUSTOM_VOCABULARY_NAME || '';
const CUSTOM_LANGUAGE_MODEL_NAME = process.env.CUSTOM_LANGUAGE_MODEL_NAME || '';
const KEEP_ALIVE = process.env.KEEP_ALIVE || '10000';
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';
const TRANSCRIBE_API_MODE = process.env.TRANSCRIBE_API_MODE || 'standard';
const BUFFER_SIZE = parseInt(process.env.BUFFER_SIZE || '128', 10);
const TCA_ENABLED = TRANSCRIBE_API_MODE === 'analytics';

// optional - provide custom Transcribe endpoint via env var
const TRANSCRIBE_ENDPOINT = process.env.TRANSCRIBE_ENDPOINT || '';
// optional - disable post call analytics output
const IS_TCA_POST_CALL_ANALYTICS_ENABLED = (process.env.IS_TCA_POST_CALL_ANALYTICS_ENABLED || 'true') === 'true';
// optional - when redaction is enabled, choose 'redacted' only (dafault), or 'redacted_and_unredacted' for both
const POST_CALL_CONTENT_REDACTION_OUTPUT = process.env.POST_CALL_CONTENT_REDACTION_OUTPUT || 'redacted';
// optional - set retry count and delay if exceptions thrown by Start Stream api
const START_STREAM_MAX_RETRIES = parseInt(process.env.START_STREAM_RETRIES || '5', 10);
const START_STREAM_RETRY_WAIT_MS = parseInt(process.env.START_STREAM_RETRY_WAIT || '1000', 10);

// create WebSocket server
const wss = new WebSocket.Server({ port: 8080 });

// aws clients
let tsClientArgs = { region: REGION };
if (TRANSCRIBE_ENDPOINT) {
  console.log("Using custom Transcribe endpoint:", TRANSCRIBE_ENDPOINT);
  tsClientArgs.endpoint = TRANSCRIBE_ENDPOINT;
}
console.log("Transcribe client args:", tsClientArgs);

const kinesisClient = new KinesisClient({ region: REGION });
const tsClient = new TranscribeStreamingClient(tsClientArgs);
const s3Client = new S3Client({ region: REGION });

// jwk-rsa
const iss = `https://cognito-idp.${REGION}.amazonaws.com/${USERPOOL_ID}`;
const jwksUri = `${iss}/.well-known/jwks.json`;
const jClient = jwksClient({ jwksUri });

wss.on('connection', (ws, req) => {
  let metadata;
  let passthroughStream;
  let sessionId;
  let callFileStream;
  let audioStream;
  let recordingFileName;
  let shouldRecordCall;

  const copyRecordingToS3 = async function () {
    fs.readFile(recordingFileName, async (err, data) => {
      try {
        console.log('Copying recording to s3');
        const input = {
          "Bucket": OUTPUT_BUCKET,
          "Body": data,
          "Key": `${RECORDING_FILE_PREFIX}${metadata.callId}.wav`
        };
        const command = new PutObjectCommand(input);
        const response = await s3Client.send(command);
        console.log(response);
        writeS3UrlToKds(kinesisClient, metadata.callId, OUTPUT_BUCKET, REGION, RECORDING_FILE_PREFIX, KINESIS_STREAM_NAME);
      } catch (error) {
        console.log('error copying file to s3:', error);
      }
    });
  }

  const startTranscribe = async function () {
    passthroughStream = new stream.PassThrough({ highWaterMark: BUFFER_SIZE });
    audioStream = async function* audioStream() {
      try {
        if (TCA_ENABLED) {
          const channel0 = { ChannelId: 0, ParticipantRole: ParticipantRole.CUSTOMER };
          const channel1 = { ChannelId: 1, ParticipantRole: ParticipantRole.AGENT };
          const channelDefinitions = [];
          channelDefinitions.push(channel0);
          channelDefinitions.push(channel1);
          let configurationEvent = {
            ChannelDefinitions: channelDefinitions,
          };
          if (IS_TCA_POST_CALL_ANALYTICS_ENABLED) {
            configurationEvent.PostCallAnalyticsSettings = {
              OutputLocation: `s3://${OUTPUT_BUCKET}/${CALL_ANALYTICS_FILE_PREFIX}`,
              DataAccessRoleArn: TCA_DATA_ACCESS_ROLE_ARN
            };
            if (IS_CONTENT_REDACTION_ENABLED) {
              configurationEvent.PostCallAnalyticsSettings.ContentRedactionOutput = POST_CALL_CONTENT_REDACTION_OUTPUT;
            }
          }
          console.log('Sending TCA configuration event');
          console.log(JSON.stringify(configurationEvent));
          yield { ConfigurationEvent: configurationEvent };
        }
        for await (const payloadChunk of passthroughStream) {
          yield { AudioEvent: { AudioChunk: payloadChunk } };
        }
      } catch (error) {
        console.log('Error reading passthrough stream or yielding audio chunk. SessionId: ', sessionId, error);
      }
    };

    let tsStream;
    const tsParams = {
      LanguageCode: TRANSCRIBE_LANGUAGE_CODE,
      MediaSampleRateHertz: 8000,
      MediaEncoding: 'pcm',
      AudioStream: audioStream(),
    };
  
    /* configure stream transcription parameters */
    if (!TCA_ENABLED) {
      tsParams.NumberOfChannels = 2;
      tsParams.EnableChannelIdentification = true;
    }
  
    /* common optional stream parameters */
    if (sessionId !== undefined) {
      tsParams.SessionId = sessionId;
    }
    if (IS_CONTENT_REDACTION_ENABLED && TRANSCRIBE_LANGUAGE_CODE === 'en-US') {
      tsParams.ContentRedactionType = CONTENT_REDACTION_TYPE;
      if (PII_ENTITY_TYPES) tsParams.PiiEntityTypes = PII_ENTITY_TYPES;
    }
    if (CUSTOM_VOCABULARY_NAME) {
      tsParams.VocabularyName = CUSTOM_VOCABULARY_NAME;
    }
    if (CUSTOM_LANGUAGE_MODEL_NAME) {
      tsParams.LanguageModelName = CUSTOM_LANGUAGE_MODEL_NAME;
    }
    /* start the stream - retry on exceptions */
    let tsResponse;
    let retryCount = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        if (TCA_ENABLED) {
          console.log("Transcribe StartCallAnalyticsStreamTranscriptionCommand args:", tsParams);
          tsResponse = await tsClient.send(new StartCallAnalyticsStreamTranscriptionCommand(tsParams));
          tsStream = stream.Readable.from(tsResponse.CallAnalyticsTranscriptResultStream);
        } else {
          console.log("Transcribe StartStreamTranscriptionCommand args:", tsParams);
          tsResponse = await tsClient.send(new StartStreamTranscriptionCommand(tsParams));
          tsStream = stream.Readable.from(tsResponse.TranscriptResultStream);
        }
        break;
      } catch (e) {
        console.log(`StartStream threw exception on attempt ${retryCount} of ${START_STREAM_MAX_RETRIES}: `, e);
        if (++retryCount > START_STREAM_MAX_RETRIES) throw e;
        await sleep(START_STREAM_RETRY_WAIT_MS);
      }
    }

    try {
      for await (const event of tsStream) {
        console.log(metadata.callId + ": " + event);
        if (event.UtteranceEvent) { 
          writeAddTranscriptSegmentEventToKds(kinesisClient, event.UtteranceEvent, undefined, metadata.callId, true, KINESIS_STREAM_NAME);
        }
        if (event.CategoryEvent) {
          writeCategoryEventToKds(kinesisClient, event.CategoryEvent, metadata.callId, KINESIS_STREAM_NAME);
        }
        if (event.TranscriptEvent) {
          writeTranscriptionSegmentToKds(kinesisClient, event.TranscriptEvent, metadata.callId, true, KINESIS_STREAM_NAME);
          //ws.send(JSON.stringify(event.TranscriptEvent.Transcript));
        }
      }
    } catch (error) {
      console.error('Error processing transcribe stream. SessionId: ', sessionId, error);
    } finally {
      writeCallEndEventToKds(kinesisClient, metadata.callId, KINESIS_STREAM_NAME)
    }
  }

  ws.on('close', () => {
    if (passthroughStream) {
      passthroughStream.end();
    }
    if (callFileStream) {
      callFileStream.end();
    }
    if(shouldRecordCall) {
      copyRecordingToS3();
    }
  });

  ws.on('error', (err) => {
    console.log('WebSocket error: ', err);
  });

  ws.on('message', async (message, isBinary) => {
    while (!ws.authorized) {
      await sleep(100);
    }
    if (!isBinary) {
      console.log('metadata received');
      // Process metadata
      metadata = JSON.parse(message);
      console.log(metadata);
      if (metadata.shouldRecordCall) {
        shouldRecordCall = metadata.shouldRecordCall;
      } else {
        shouldRecordCall = true;
      }
      
      writeCallStartEventToKds(kinesisClient, metadata, KINESIS_STREAM_NAME)

      // Create metadata file
      // metadataFileName = `${TEMP_FILE_PATH}${RECORDING_FILE_PREFIX}${metadata.callId}_metadata.json`
      // fs.writeFileSync(metadataFileName, JSON.stringify(metadata, null, 2));
      
      // Create audio file stream
      if (shouldRecordCall) {
        recordingFileName = `${TEMP_FILE_PATH}${RECORDING_FILE_PREFIX}${metadata.callId}.wav`;
        callFileStream = new FileWriter(recordingFileName, {
          sampleRate: 8000,
          channels: 2,
          bitDepth: 16
        });
      }

      startTranscribe();

    } else {
      // Process audio data
      if (passthroughStream) {
        if(shouldRecordCall && callFileStream) callFileStream.write(message);
        passthroughStream.write(message);
      } else {
        console.log('Error: received audio data before metadata');
      }
    }
  });

  const authorizationHeader = req.headers['authorization'];
  if (!authorizationHeader) {
    ws.close(1008, 'Authorization header missing');
    return;
  }
  const tokenParts = authorizationHeader.split(' ');
  if (tokenParts.length !== 2 || tokenParts[0] !== 'Bearer') {
    ws.close(1008, 'Invalid authorization header format');
    return;
  }
  const token = tokenParts[1];
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header) {
    ws.close(1008, 'Invalid token');
    return;
  }
  const header = decoded.header;

  jClient.getSigningKey(header.kid, function (err, key) {
    if (err) {
      console.log("Invalid token", err);
      ws.close(1008, 'Invalid token');
      return;
    }
    const signingKey = key.publicKey || key.rsaPublicKey;

    jwt.verify(token, signingKey, { algorithms: ['RS256'], issuer: iss }, function (err, decoded) {
      if (err) {
        console.log("Invalid token", err);
        ws.close(1008, 'Invalid token');
        return;
      }
      console.log('Decoded JWT - you can use these to process information about this call from the client:', decoded);
      ws.authorized = true;
    });
  });
});

console.log('WebSocket server is running on ws://localhost:8080');
