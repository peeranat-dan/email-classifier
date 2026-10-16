import { defineBoolean, defineList, defineSecret, defineString } from 'firebase-functions/params';

export const REGION = 'asia-southeast1';

export const TOPICS = {
  gmailNotifications: 'gmail-notifications',
  classifyEmail: 'email-classify',
  emailFeedback: 'email-feedback',
} as const;

export const secrets = {
  anthropicApiKey: defineSecret('ANTHROPIC_API_KEY'),
  gmailClientSecret: defineSecret('GMAIL_CLIENT_SECRET'),
  gmailRefreshToken: defineSecret('GMAIL_REFRESH_TOKEN'),
};

export const GMAIL_SECRETS = [secrets.gmailClientSecret, secrets.gmailRefreshToken];

export const params = {
  gmailAddress: defineString('GMAIL_ADDRESS'),
  gmailClientId: defineString('GMAIL_CLIENT_ID'),
  anthropicModel: defineString('ANTHROPIC_MODEL', { default: 'claude-haiku-5-5' }),
  shadowMode: defineBoolean('SHADOW_MODE', { default: true }),
  minConfidence: defineString('MIN_CONFIDENCE', { default: '0.8' }),
  neverArchive: defineList('NEVER_ARCHIVE', { default: [] }), // "a@x.com" or "@x.com"
};
