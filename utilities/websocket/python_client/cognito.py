import boto3
import os

COGNITO_USERPOOL_ID = os.getenv('USERPOOL_ID', '')
COGNITO_CLIENT_ID = os.getenv('COGNITO_CLIENT_ID', '')


# Amazon Cognito creates a session which includes the id, access, and refresh tokens of an authenticated user.

def get_access_token(username, password):
  authentication_data = {
      'USERNAME': username,
      'PASSWORD': password,
  }

  # Initialize the Amazon Cognito client
  client = boto3.client('cognito-idp')

  # Pool data
  pool_data = {
      'UserPoolId': COGNITO_USERPOOL_ID,
      'ClientId': COGNITO_CLIENT_ID
  }

  # Authentication details
  response = client.initiate_auth(
      AuthFlow='USER_PASSWORD_AUTH',
      AuthParameters={
          'USERNAME': authentication_data['USERNAME'],
          'PASSWORD': authentication_data['PASSWORD'],
      },
      ClientId=pool_data['ClientId']
  )
  print(response)
  # Handling the response
  if response['AuthenticationResult']:
      access_token = response['AuthenticationResult']['AccessToken']
      id_token = response['AuthenticationResult']['IdToken']
      # Use the idToken for Logins Map when Federating User Pools with identity pools or when passing through an Authorization Header to an API Gateway Authorizer
      return access_token
  else:
      print("Authentication failed:", response['ChallengeName'])
