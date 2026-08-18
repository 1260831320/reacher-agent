# Security

## Secret handling

- Never commit API keys, Feishu credentials, SSH keys, access tokens, server addresses, or real recipient IDs.
- Put local runtime values in `.env` and deployment values in `.deploy.env`; both are gitignored.
- Keep model credentials in the external file referenced by `RAG_ENV_FILE` locally and `REMOTE_SOURCE_ENV` on the server.
- The server installer writes its dedicated environment file with mode `600`.

Before publishing changes, run:

```bash
npm test
git diff --check
git grep -nE 'sk-[A-Za-z0-9._-]{12,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY'
```

If a credential is ever committed, rotate it first and then remove it from the complete Git history before pushing.
