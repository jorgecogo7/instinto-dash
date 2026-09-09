require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  useMockData: process.env.USE_MOCK_DATA !== 'false',
  apiSecret: process.env.API_SECRET || '',
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://dash.instintodigital.com.br',

  auth: {
    username: process.env.ADMIN_USERNAME || '',
    passwordHash: process.env.ADMIN_PASSWORD_HASH || '',
  },
  tokenSecret: process.env.TOKEN_SECRET || '',

  db: {
    host: process.env.DB_HOST || '',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    name: process.env.DB_NAME || '',
  },

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
