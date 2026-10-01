// Updates an existing web app deployment (keeps the same URL) when DEPLOYMENT_ID
// is set; otherwise creates a new deployment and prints its ID.
const { execSync } = require('child_process');

const id = process.env.DEPLOYMENT_ID;
const desc = process.env.DEPLOY_DESC || `deploy ${new Date().toISOString()}`;
const cmd = id
  ? `clasp create-deployment --deploymentId ${id} --description "${desc}"`
  : `clasp create-deployment --description "${desc}"`;

if (!id) console.log('DEPLOYMENT_ID not set: creating a NEW deployment (new URL).');
execSync(cmd, { stdio: 'inherit' });
