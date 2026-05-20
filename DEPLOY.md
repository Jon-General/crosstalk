# Deploying Crosstalk Tutor on Linode

Your DeepSeek key must live on the server, not in browser JavaScript.

## 1. Rotate the exposed key

The key pasted into chat should be treated as compromised. Create a new DeepSeek API key before deploying.

## 2. Create a Linode

In Linode Cloud Manager, create a small Ubuntu LTS compute instance. Linode compute instances are Linux virtual machines with root access, so you can install Node, Nginx, and this app.

## 3. Install runtime packages

SSH into the Linode, then run:

```bash
sudo apt update
sudo apt install -y nodejs npm nginx git
node --version
npm --version
```

If Ubuntu's Node version is older than 18, install a current Node LTS from NodeSource or use `nvm`.

## 4. Upload the app

From this folder, copy the project to the server:

```bash
scp -r . root@YOUR_SERVER_IP:/opt/crosstalk
```

On the server:

```bash
cd /opt/crosstalk
npm install --omit=dev
cp .env.example .env
nano .env
```

Set:

```bash
DEEPSEEK_API_KEY=your_new_key
DEEPSEEK_MODEL=deepseek-v4-flash
PORT=3000
```

## 5. Run with systemd

Create a service:

```bash
sudo nano /etc/systemd/system/crosstalk.service
```

Paste:

```ini
[Unit]
Description=Crosstalk Mandarin Tutor
After=network.target

[Service]
WorkingDirectory=/opt/crosstalk
EnvironmentFile=/opt/crosstalk/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now crosstalk
sudo systemctl status crosstalk
```

## 6. Put Nginx in front

Create:

```bash
sudo nano /etc/nginx/sites-available/crosstalk
```

Paste:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_SERVER_IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/crosstalk /etc/nginx/sites-enabled/crosstalk
sudo nginx -t
sudo systemctl reload nginx
```

Open `http://YOUR_SERVER_IP`.

## Notes

- Browser study data is saved in the browser's local storage.
- DeepSeek lesson generation happens only through `/api/lesson`.
- Do not commit `.env`.
