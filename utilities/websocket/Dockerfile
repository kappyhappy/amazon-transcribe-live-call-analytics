# Use official Node.js 14 as the base image
FROM node:16

# Set the working directory in the Docker container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy the server script to the working directory
COPY . .

# Expose the port that the server listens on
EXPOSE 8080

# Command to run the server script
CMD [ "node", "server.js" ]