// Updates an existing web app deployment (keeps the same URL) when DEPLOYMENT_ID
// is set; otherwise creates a new deployment and prints its ID.
// Arguments are passed as an array (no shell), so quotes or metacharacters in
// DEPLOY_DESC / DEPLOYMENT_ID cannot break or inject into the command.
const { execFileSync } = require('child_process');

const id = process.env.DEPLOYMENT_ID;
const desc = process.env.DEPLOY_DESC || `deploy ${new Date().toISOString()}`;
const args = ['create-deployment', ...(id ? ['--deploymentId', id] : []), '--description', desc];

if (!id) console.log('DEPLOYMENT_ID not set: creating a NEW deployment (new URL).');
execFileSync('clasp', args, { stdio: 'inherit' });
