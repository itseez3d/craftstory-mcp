# Security

Report vulnerabilities privately through GitHub's "Report a vulnerability" form on this repository
(Security tab) rather than in a public issue. We aim to respond within 5 business days.

Notes for deployers:

- The server holds your CraftStory API key (`CRAFTSTORY_API_KEY`) and sends it only to `CRAFTSTORY_API_BASE`
  (default `https://api.craftstory.com/api/v1`; plaintext HTTP is refused unless `CRAFTSTORY_ALLOW_HTTP=1`).
- Tools that take a local path (`image_path`, `file_path`, `reference_files`) upload that file to the CraftStory API.
  Run the server as a user that can only read what you intend to share, and keep your MCP client's tool-approval
  prompts on; the server does not sandbox paths itself.
- Keep API keys out of project-local config that may be committed (see README for the environment-variable forms).
