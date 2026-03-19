// Zet nep Firebase credentials zodat firebase.js kan initialiseren tijdens tests
process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test',
  private_key_id: 'test',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4LksXpAOXtOoGU4GDMxFCKpTFuW\nuJU5KXV0RS5PRFY+VKPV3qdCCf9u7w4JfUZuDDAJqGCFfCfXimGd2a72u0YMqVB8\nXNBQmwBiXCCv5eIBWMGhH3sGMHLi5nujSLilgbxKG5bfCnWAyQXFDXEJiNRCdaGe\n9UWLEGcfCAEAAQIDAQABAoIBADEzInAqE3NxJBLJOVAFSKiFVnbpyZtk6FAhPNBo\nW7u2ckGwgHPxmEIV1nFMOGq5XFcQcVfaHWWvpWBqdLwBkNXJoRdqJiLBkk1Inh/\n20AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@test.iam.gserviceaccount.com',
  client_id: '123',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
});
process.env.APP_URL = 'http://localhost:3000';
process.env.EMAIL_USER = 'test@test.com';
process.env.EMAIL_PASS = 'test';
