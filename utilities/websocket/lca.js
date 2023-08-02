/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */

const { InvokeCommand } = require('@aws-sdk/client-lambda'); 
const { GetItemCommand, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { PutRecordCommand } = require('@aws-sdk/client-kinesis');
const fs = require('fs');

// Add a '/' to S3 or HTML paths if needed
const formatPath = function(path) {
  let pathOut = path;
  if (path.length > 0 && path.charAt(path.length - 1) != "/") {
    pathOut += "/";
  }
  return pathOut;
}

const getExpiration = function getExpiration(numberOfDays) {
  return Math.round(Date.now() / 1000) + numberOfDays * 24 * 3600;
};

const sleep = async function sleep(msec) {
  return new Promise((resolve) => {
    setTimeout(resolve, msec);
  });
};

/*const REGION = process.env.REGION || 'us-east-1';
const SAVE_PARTIAL_TRANSCRIPTS = (process.env.SAVE_PARTIAL_TRANSCRIPTS || 'true') === 'true';
const KINESIS_STREAM_NAME = process.env.KINESIS_STREAM_NAME || '';
const { OUTPUT_BUCKET } = process.env;
const RECORDING_FILE_PREFIX = formatPath(process.env.RECORDING_FILE_PREFIX || 'lca-audio-recordings/');
const LAMBDA_HOOK_FUNCTION_ARN = process.env.LAMBDA_HOOK_FUNCTION_ARN || '';*/

const expireInDays = 90;

const EVENT_TYPE = {
  STARTED: 'START',
  ENDED: 'END',
  FAILED: 'ERROR',
  CONTINUE: 'CONTINUE',
};

const writeTranscriptionSegmentToKds = async function writeTranscriptionSegmentToKds(
  kinesisClient,
  transcriptionEvent,
  callId,
  savePartialTranscripts,
  kinesisStreamName
) {
  // only write if there is more than 0
  const result = transcriptionEvent.Transcript.Results[0];
  if (!result) return;
  if (result.IsPartial === true && !savePartialTranscripts) {
    return;
  }
  const transcript = result.Alternatives[0];
  if (!transcript.Transcript) return;

  console.log('Sending ADD_TRANSCRIPT_SEGMENT event on KDS');

  const channel = result.ChannelId === 'ch_0' ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();
  const eventType = 'ADD_TRANSCRIPT_SEGMENT';

  const putObj = {
    Channel: channel,
    CallId: callId,
    SegmentId: result.ResultId,
    StartTime: result.StartTime.toString(),
    EndTime: result.EndTime.toString(),
    Transcript: result.Alternatives[0].Transcript,
    IsPartial: result.IsPartial,
    EventType: eventType.toString(),
    CreatedAt: now,
  };

  const putParams = {
    StreamName: kinesisStreamName,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing ADD_TRANSCRIPT_SEGMENT event', error);
  }
};

const writeAddTranscriptSegmentEventToKds = async function writeAddTranscriptSegmentEventToKds(
  kinesisClient,
  utteranceEvent,
  transcriptEvent,
  callId,
  savePartialTranscripts,
  kinesisStreamName
) {
  if (transcriptEvent) {
    if (transcriptEvent.Transcript?.Results && transcriptEvent.Transcript?.Results.length > 0) {
      if (
        // eslint-disable-next-line operator-linebreak
        transcriptEvent.Transcript?.Results[0].Alternatives &&
        transcriptEvent.Transcript?.Results[0].Alternatives?.length > 0
      ) {
        const result = transcriptEvent.Transcript?.Results[0];
        if (
          // eslint-disable-next-line operator-linebreak
          result.IsPartial === undefined ||
          (result.IsPartial === true && !savePartialTranscripts)
        ) {
          return;
        }
      }
    }
  }

  if (utteranceEvent) {
    if (
      // eslint-disable-next-line operator-linebreak
      utteranceEvent.IsPartial === undefined ||
      (utteranceEvent.IsPartial === true && !savePartialTranscripts)
    ) {
      return;
    }
  }

  const now = new Date().toISOString();

  const kdsObject = {
    EventType: 'ADD_TRANSCRIPT_SEGMENT',
    CallId: callId,
    TranscriptEvent: transcriptEvent,
    UtteranceEvent: utteranceEvent,
    CreatedAt: now,
    UpdatedAt: now,
  };

  const putParams = {
    StreamName: kinesisStreamName,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(kdsObject)),
  };

  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
    console.info('Written ADD_TRANSCRIPT_SEGMENT event to KDS');
    console.info(JSON.stringify(kdsObject));
  } catch (error) {
    console.error('Error writing transcription segment to KDS', error);
    console.debug(JSON.stringify(kdsObject));
  }
};

const writeUtteranceEventToKds = async function writeUtteranceEventToKds(
  kinesisClient,
  utterances,
  callId,
  savePartialTranscripts,
  kinesisStreamName
) {
  if (utterances) {
    if (
      utterances.IsPartial === undefined 
      || (utterances.IsPartial === true && !savePartialTranscripts)
    ) {
      return;
    }
    if (utterances.Transcript) {
      const now = new Date().toISOString();
      const expiration = Math.round(Date.now() / 1000) + expireInDays * 24 * 3600;
      const kdsObject = {
        EventType: 'ADD_TRANSCRIPT_SEGMENT',
        CallId: callId,
        Channel: utterances.ParticipantRole || '',
        SegmentId: utterances.UtteranceId || '',
        StartTime: (utterances.BeginOffsetMillis || 0) / 1000,
        EndTime: (utterances.EndOffsetMillis || 0) / 1000,
        Transcript: utterances.Transcript,
        IsPartial: utterances.IsPartial,
        CreatedAt: now,
        ExpiresAfter: expiration.toString(),
        Sentiment: undefined,
        IssuesDetected: undefined,
      };
      if (utterances.Sentiment) {
        kdsObject.Sentiment = utterances.Sentiment;
      }

      if (utterances.IssuesDetected) {
        kdsObject.IssuesDetected = utterances.IssuesDetected;
      }
      const putParams = {
        StreamName: kinesisStreamName,
        PartitionKey: callId,
        Data: Buffer.from(JSON.stringify(kdsObject)),
      };

      const putCmd = new PutRecordCommand(putParams);
      try {
        await kinesisClient.send(putCmd);
        console.info('Written TCA ADD_TRANSCRIPT_SEGMENT event to KDS');
        console.info(JSON.stringify(kdsObject));
      } catch (error) {
        console.error('Error writing transcription segment (TCA) to KDS', error);
      }
    }
  }
};

const writeCategoryEventToKds = async function writeCategoryEventToKds(
  kinesisClient,
  categoryEvent,
  callId,
  kinesisStreamName,
) {
  if (categoryEvent) {
    const now = new Date().toISOString();

    const kdsObject = {
      EventType: 'ADD_CALL_CATEGORY',
      CallId: callId,
      CategoryEvent: categoryEvent,
      CreatedAt: now,
    };

    const putParams = {
      StreamName: kinesisStreamName,
      PartitionKey: callId,
      Data: Buffer.from(JSON.stringify(kdsObject)),
    };

    const putCmd = new PutRecordCommand(putParams);
    try {
      await kinesisClient.send(putCmd);
      console.debug('Written ADD_CALL_CATEGORY to KDS');
      console.debug(JSON.stringify(kdsObject));
    } catch (error) {
      console.error('Error writing ADD_CALL_CATEGORY to KDS', error);
      console.debug(JSON.stringify(kdsObject));
    }
  }
};

const writeCallStartEventToKds = async function writeCallStartEventToKds(
  kinesisClient,
  callData,
  kinesisStreamName
) {
  console.log('Write Call Start Event to KDS');
  const putObj = {
    CallId: callData.callId,
    CreatedAt: new Date().toISOString(),
    CustomerPhoneNumber: callData.fromNumber,
    SystemPhoneNumber: callData.toNumber,
    AgentId: callData.agentId,
    EventType: 'START',
  };
  const putParams = {
    StreamName: kinesisStreamName,
    PartitionKey: callData.callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log('Sending Call START event on KDS: ', JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call START event', error);
  }
};

const writeCallEndEventToKds = async function writeCallEndEventToKds(
  kinesisClient,
  callId,
  kinesisStreamName,
) {
  console.log('Write Call End Event to KDS');
  const putObj = {
    CallId: callId,
    EventType: 'END',
  };
  const putParams = {
    StreamName: kinesisStreamName,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  console.log('Sending Call END event on KDS: ', JSON.stringify(putObj));
  const putCmd = new PutRecordCommand(putParams);
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing call END', error);
  }
};

const writeS3UrlToKds = async function writeS3UrlToKds(kinesisClient, callId, outputBucket, region, recordingFilePrefix, kinesisStreamName) {
  console.log('Writing S3 URL To KDS');
  const now = new Date().toISOString();
  const eventType = 'ADD_S3_RECORDING_URL';
  const recordingUrl = `https://${outputBucket}.s3.${region}.amazonaws.com/${recordingFilePrefix}${callId}.wav`;
  const putObj = {
    CallId: callId,
    RecordingUrl: recordingUrl,
    EventType: eventType.toString(),
    CreatedAt: now,
  };
  const putParams = {
    StreamName: kinesisStreamName,
    PartitionKey: callId,
    Data: Buffer.from(JSON.stringify(putObj)),
  };
  const putCmd = new PutRecordCommand(putParams);
  console.log('Sending ADD_S3_RECORDING_URL event on KDS: ', JSON.stringify(putObj));
  try {
    await kinesisClient.send(putCmd);
  } catch (error) {
    console.error('Error writing ADD_S3_RECORDING_URL event', error);
  }
};

const getCallDataFromChimeEvents = async function getCallDataFromChimeEvents(
  callEvent,
  outputBucket,
  callAnalyticsFilePrefix,
  lambdaHookFunctionArn,
  lambdaClient
) {
  const callerStreamArn = callEvent.detail.streamArn;
  const agentStreamArn = await getChannelStreamFromDynamo(callEvent.detail.callId, 'AGENT', 100);
  if (agentStreamArn === undefined) {
    console.log('Timed out waiting for AGENT stream event after 10s. Exiting.');
    return undefined;
  }

  const now = new Date().toISOString();
  const callData = {
    callId: callEvent.detail.callId,
    originalCallId: callEvent.detail.callId,
    callStreamingStartTime: now,
    callProcessingStartTime: now,
    callStreamingEndTime: '',
    shouldProcessCall: true,
    shouldRecordCall: true,
    fromNumber: callEvent.detail.fromNumber,
    toNumber: callEvent.detail.toNumber,
    agentId: callEvent.detail.agentId,
    metadatajson: undefined,
    callerStreamArn,
    agentStreamArn,
    lambdaCount: 0,
    sessionId: undefined,
    tcaOutputLocation: `s3://${outputBucket}/${callAnalyticsFilePrefix}`,
  };

  // Call customer LambdaHook, if present
  if (lambdaHookFunctionArn) {
    // invoke lambda function
    // if it fails, just throw an exception and exit
    console.log(`Invoking LambdaHook: ${lambdaHookFunctionArn}`);
    const invokeCmd = new InvokeCommand({
      FunctionName: lambdaHookFunctionArn,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(callEvent),
    });
    const lambdaResponse = await lambdaClient.send(invokeCmd);
    const payload = JSON.parse(Buffer.from(lambdaResponse.Payload));
    console.log(`LambdaHook response: ${JSON.stringify(payload)}`);
    if (lambdaResponse.FunctionError) {
      console.log('Lambda failed to run, throwing an exception');
      throw new Error(payload);
    }
    /* Process the response. All fields optional:
        {
          // all fields optional
          originalCallId: <string>,
          shouldProcessCall: <boolean>,
          isCaller: <boolean>,
          callId: <string>,
          agentId: <string>,
          fromNumber: <string>,
          toNumber: <string>,
          shouldRecordCall: <boolean>,
          metadatajson: <string>
        }
    */

    // New CallId?
    if (payload.callId) {
      console.log(`Lambda hook returned new callId: "${payload.callId}"`);
      callData.callId = payload.callId;
    }

    // Swap caller and agent channels?
    if (payload.isCaller === false) {
      console.log('Lambda hook returned isCaller=false, swapping caller/agent streams');
      [callData.agentStreamArn, callData.callerStreamArn] = [
        callData.callerStreamArn,
        callData.agentStreamArn,
      ];
    }
    if (payload.isCaller === true) {
      console.log('Lambda hook returned isCaller=true, caller/agent streams not swapped');
    }

    // AgentId?
    if (payload.agentId) {
      console.log(`Lambda hook returned agentId: "${payload.agentId}"`);
      callData.agentId = payload.agentId;
    }

    // New 'to' or 'from' phone numbers?
    if (payload.fromNumber) {
      console.log(`Lambda hook returned fromNumber: "${payload.fromNumber}"`);
      callData.fromNumber = payload.fromNumber;
    }
    if (payload.toNumber) {
      console.log(`Lambda hook returned toNumber: "${payload.toNumber}"`);
      callData.toNumber = payload.toNumber;
    }

    // Metadata?
    if (payload.metadatajson) {
      console.log(`Lambda hook returned metadatajson: "${payload.metadatajson}"`);
      callData.metadatajson = payload.metadatajson;
    }

    // Should we process this call?
    if (payload.shouldProcessCall === false) {
      console.log('Lambda hook returned shouldProcessCall=false.');
      callData.shouldProcessCall = false;
      callData.callProcessingStartTime = '';
    }
    if (payload.shouldProcessCall === true) {
      console.log('Lambda hook returned shouldProcessCall=true.');
    }

    // Should we record this call?
    if (payload.shouldRecordCall === false) {
      console.log('Lambda hook returned shouldRecordCall=false.');
      callData.shouldRecordCall = false;
    }
    if (payload.shouldRecordCall === true) {
      console.log('Lambda hook returned shouldRecordCall=true.');
    }
  }
  return callData;
};

// Retrieve Chime stream event for specified channel, waiting for up to 10s
const getChannelStreamFromDynamo = async function getChannelStreamFromDynamo(
  callId,
  channel,
  retries,
  transcriberCallEventTableName,
  dynamoClient
) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `ce#${callId}`,
      },
      SK: {
        S: `${channel}`,
      },
    },
    TableName: transcriberCallEventTableName,
  };
  console.log('GetItem params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let agentStreamArn;
  let loopCount = 0;

  // eslint-disable-next-line no-plusplus
  while (agentStreamArn === undefined && loopCount++ < retries) {
    const data = await dynamoClient.send(command);
    console.log('GetItem result: ', JSON.stringify(data));
    if (data.Item) {
      if (data.Item.StreamArn) agentStreamArn = data.Item.StreamArn.S;
    } else {
      console.log(`${channel} stream not yet available.`);
      if (loopCount < retries) {
        console.log(loopCount, `Sleeping 100ms.`);
        await sleep(100);
      }
    }
  }
  return agentStreamArn;
};

const writeChimeCallStartEventToDdb = async function writeChimeCallStartEventToDdb(
  callEvent,
  transcriberCallEventTableName,
  dynamoClient
) {
  const expiration = getExpiration(1);
  const eventType = EVENT_TYPE[callEvent.detail.streamingStatus];
  const channel = callEvent.detail.isCaller ? 'CALLER' : 'AGENT';
  const now = new Date().toISOString();

  const putParams = {
    TableName: transcriberCallEventTableName,
    Item: {
      PK: { S: `ce#${callEvent.detail.callId}` },
      SK: { S: `${channel}` },
      CallId: { S: callEvent.detail.callId },
      ExpiresAfter: { N: expiration.toString() },
      CreatedAt: { S: now },
      CustomerPhoneNumber: { S: callEvent.detail.fromNumber },
      SystemPhoneNumber: { S: callEvent.detail.toNumber },
      Channel: { S: channel },
      EventType: { S: eventType },
      StreamArn: { S: callEvent.detail.streamArn },
    },
  };
  console.log('Writing Chime Call Start event to DynamoDB: ', JSON.stringify(putParams));
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Chime Call Start event', error);
  }
};


const writeCallDataToDdb = async function writeCallDataToDdb(
  callData,
  transcriberCallEventTableName,
  dynamoClient,
) {
  console.log('Write callData to DDB');
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: transcriberCallEventTableName,
    Item: {
      PK: { S: `cd#${callData.callId}` },
      SK: { S: 'BOTH' },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
      CallData: { S: JSON.stringify(callData) },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Call Data to Ddb', error);
  }
};


const writeSessionDataToDdb = async function writeSessionDataToDdb(
  sessionData,
  transcriberCallEventTableName,
  dynamoClient
) {
  console.log('Write sessionData to DDB');
  const expiration = getExpiration(1);
  const now = new Date().toISOString();
  const putParams = {
    TableName: transcriberCallEventTableName,
    Item: {
      PK: { S: `sd#${sessionData.sessionId}` },
      SK: { S: 'TRANSCRIBE SESSION' },
      CreatedAt: { S: now },
      ExpiresAfter: { N: expiration.toString() },
      SessionData: { S: JSON.stringify(sessionData) },
    },
  };
  console.log(putParams);
  const putCmd = new PutItemCommand(putParams);
  try {
    await dynamoClient.send(putCmd);
  } catch (error) {
    console.error('Error writing Session Data to Ddb', error);
  }
};


const getCallDataFromDdb = async function getCallDataFromDdb(
  callId,
  transcriberCallEventTableName,
  dynamoClient
) {
  // Set the parameters
  const params = {
    Key: {
      PK: {
        S: `cd#${callId}`,
      },
      SK: {
        S: 'BOTH',
      },
    },
    TableName: transcriberCallEventTableName,
  };
  console.log('GetItem params: ', JSON.stringify(params));
  const command = new GetItemCommand(params);
  let callData;
  try {
    const data = await dynamoClient.send(command);
    console.log('GetItem result: ', JSON.stringify(data));
    callData = JSON.parse(data.Item.CallData.S);
  } catch (error) {
    console.log('Error retrieving callData - Possibly invalid callId?: ', error);
  }
  return callData;
};


const getCallDataForStartCallEvent = async function getCallDataForStartCallEvent(scpevent) {
  const { callId } = scpevent;
  const callData = await getCallDataFromDdb(callId);
  if (!callData) {
    console.log(`ERROR: No callData stored for callId: ${callId} - exiting.`);
    return undefined;
  }
  if (callData.callProcessingStartTime) {
    console.log(`ERROR: Call ${callId} is already processed/processing - exiting.`);
    return undefined;
  }
  // Add Start Call Event info to saved callData object and write back to DDB for tracing
  callData.startCallProcessingEvent = scpevent;
  callData.callProcessingStartTime = new Date().toISOString();
  /* Start Call Event can contain following optional fields, used to modify callData:
          agentId: <string>,
          fromNumber: <string>,
          toNumber: <string>
  */
  // AgentId?
  if (scpevent.agentId) {
    console.log(`START_CALL_PROCESSING event contains agentId: "${scpevent.agentId}"`);
    callData.agentId = scpevent.agentId;
  }
  // New 'to' or 'from' phone numbers?
  if (scpevent.fromNumber) {
    console.log(`START_CALL_PROCESSING event contains fromNumber: "${scpevent.fromNumber}"`);
    callData.fromNumber = scpevent.fromNumber;
  }
  if (scpevent.toNumber) {
    console.log(`START_CALL_PROCESSING event contains toNumber: "${scpevent.toNumber}"`);
    callData.toNumber = scpevent.toNumber;
  }
  return callData;
};


const writeToS3 = async function writeToS3(tempFileName, tempFilePath, outputBucket, rawFilePrefix, s3Client) {
  const sourceFile = tempFilePath + tempFileName;
  console.log('Uploading audio to S3');
  let data;
  const fileStream = fs.createReadStream(sourceFile);
  const uploadParams = {
    Bucket: outputBucket,
    Key: rawFilePrefix + tempFileName,
    Body: fileStream,
  };
  try {
    data = await s3Client.send(new PutObjectCommand(uploadParams));
    console.log('Uploading to S3 complete: ', data);
  } catch (err) {
    console.error('S3 upload error: ', err);
  } finally {
    fileStream.destroy();
  }
  return data;
};

const deleteTempFile = async function deleteTempFile(sourceFile) {
  try {
    console.log('deleting tmp file');
    await fs.promises.unlink(sourceFile);
  } catch (err) {
    console.error('error deleting: ', err);
  }
};

exports.sleep = sleep;
exports.deleteTempFile = deleteTempFile;
exports.formatPath = formatPath;
exports.getCallDataFromChimeEvents = getCallDataFromChimeEvents;
exports.getChannelStreamFromDynamo = getChannelStreamFromDynamo;
exports.getCallDataFromDdb = getCallDataFromDdb;
exports.getCallDataForStartCallEvent = getCallDataForStartCallEvent;
exports.writeS3UrlToKds = writeS3UrlToKds;
exports.writeTranscriptionSegmentToKds = writeTranscriptionSegmentToKds;
exports.writeCallStartEventToKds = writeCallStartEventToKds;
exports.writeCallEndEventToKds = writeCallEndEventToKds;
exports.writeUtteranceEventToKds = writeUtteranceEventToKds;
exports.writeCategoryEventToKds = writeCategoryEventToKds;
exports.writeAddTranscriptSegmentEventToKds = writeAddTranscriptSegmentEventToKds;
exports.writeChimeCallStartEventToDdb = writeChimeCallStartEventToDdb;
exports.writeCallDataToDdb = writeCallDataToDdb;
exports.writeSessionDataToDdb = writeSessionDataToDdb;
exports.writeToS3 = writeToS3;
