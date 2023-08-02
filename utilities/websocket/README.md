# Introduction

## Server

### Pre-requisites

If you're going to run this on a standalone server, you will need to install NodeJS v16.x. It also runs on Docker, and will download and install the requirements automatically.

### How to run (stand-alone)

Set the required LCA environment variable constants, or hard code them into server.js. You can find these from the LCA stack output.

```
export REGION=us-east-1
export USERPOOL_ID=us-east-1_XXXXXXXXX
export KINESIS_STREAM_NAME=XYZ-AISTACK-XXXXXXXXXXXXX-CallDataStream-YYYYYYYYYYYY
export OUTPUT_BUCKET=XYZ-aistack-XXXXXXXXXXXXX-recordingsbucket-YYYYYYYYYYYY
```

Once these are set, install the required npm packages by running `npm install`.

Finally, start the server with `node server.js`

### How to run (Docker)

- Edit the `Dockerfile` with the LCA environment variable values, as seen above.
- Build the docker image: `docker build -t lca-websocket-server .`
- Run the image: `docker run -p 8080:8080 lca-websocket-server`
- or Run the image with output folder mapped locally:  `docker run -p 8080:8080 -v $(pwd)/output:/usr/src/app/output lca-websocket-server`

This will map port 8080 from the container to your localhost.

## Client

### Pre-requisites

- Python 3.10 or NodeJS 16
- `pip install websockets`

### How to run client (python)

Set an environment variable for JWT_TOKEN. This can be generated from the [Cognito User Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html) deployed with LCA.

`export JWT_TOKEN=XXXXXXXXX.YYYYYYYY.ZZZZZ`

Next, run the client: `python client.py`


### How to run client (Node)

Set an environment variable for JWT_TOKEN. This can be generated from the [Cognito User Pool](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-identity-pools.html) deployed with LCA.

`export JWT_TOKEN=XXXXXXXXX.YYYYYYYY.ZZZZZ`

Next, run the client: `node client.js`