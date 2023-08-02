# Use official Node.js 14 as the base image
FROM node:16

# Configure Environment variables
ENV REGION=us-east-1
ENV USERPOOL_ID=us-east-1_XXXXXXXXX
ENV KINESIS_STREAM_NAME=XYZ-AISTACK-XXXXXXXXXXXXX-CallDataStream-YYYYYYYYYYYY
ENV OUTPUT_BUCKET=XYZ-aistack-XXXXXXXXXXXXX-recordingsbucket-YYYYYYYYYYYY

# Set the working directory in the Docker container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy the server script to the working directory
COPY server.js .

# Expose the port that the server listens on
EXPOSE 8080

# Command to run the server script
CMD [ "node", "server.js" ]