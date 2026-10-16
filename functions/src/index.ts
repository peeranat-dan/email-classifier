import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions';

initializeApp();
setGlobalOptions({ maxInstances: 5 });

export { onGmailNotification } from './handlers/on-gmail-notification.js';
export { onClassifyEmail } from './handlers/on-classify-email.js';
export { onEmailFeedback } from './handlers/on-email-feedback.js';
export { onRenewWatch } from './handlers/on-renew-watch.js';
