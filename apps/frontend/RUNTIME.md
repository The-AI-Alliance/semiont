# Frontend Runtime Directory

This directory contains runtime files for the frontend service.

## Structure

- `.env.local` - Environment configuration (git-ignored)
- `logs/` - Application logs
- `tmp/` - Temporary files
- `.pid` - Process ID when running

## Configuration

Edit `.env.local` to configure:
- Server API URL (SERVER_API_URL) - set to localhost for POSIX platform
- Port (PORT)
- Other environment-specific settings

## Source Code

The frontend source code is located at:
/Users/pingel/git_repos/github.com/The-AI-Alliance/semiont/apps/frontend

## Commands

- Start: `semiont start --service frontend --environment local`
- Check: `semiont check --service frontend --environment local`
- Stop: `semiont stop --service frontend --environment local`
- Logs: `tail -f logs/app.log`
