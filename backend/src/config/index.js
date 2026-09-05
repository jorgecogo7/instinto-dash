require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  useMockData: process.env.USE_MOCK_DATA !== 'false',

  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || '',
    systemUserToken: process.env.META_SYSTEM_USER_TOKEN || '',
    apiVersion: process.env.META_API_VERSION || 'v21.0',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    developerToken: process.env.GOOGLE_DEVELOPER_TOKEN || '',
    loginCustomerId: process.env.GOOGLE_LOGIN_CUSTOMER_ID || '',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
};
