# aclude-relay-server

Canonical source for the Aclude relay-server — the WebSocket PTY bridge that runs Claude Code CLI on cloud VMs and pipes I/O to browser-side WebContainers.

## Install

```bash
git clone https://github.com/hihihihihiihihihihihihhhihihihhiihi/aclude-relay-server.git
cd aclude-relay-server
npm install
npm run build
```

## Run

```bash
RELAY_PORT=8080 node dist/index.js
```

Or via systemd (see the `aclude-relay.service` unit on existing worker nodes).

## Update

```bash
git pull
npm install
npm run build
sudo systemctl restart aclude-relay
```
