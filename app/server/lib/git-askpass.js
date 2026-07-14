// git 透過 GIT_ASKPASS 呼叫本腳本索取帳/密：Username 回 x-access-token、Password 回 GIT_PAT。
// token 只從 env 讀取，不進 argv/log。
const prompt = process.argv[2] || '';
const pat = process.env.GIT_PAT || '';
process.stdout.write((/username/i.test(prompt) ? 'x-access-token' : pat) + '\n');
