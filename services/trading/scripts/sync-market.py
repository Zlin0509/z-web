#!/usr/bin/env python3
"""Signed, market-data-only updater. Keep the config outside Git with mode 0600."""
import argparse, datetime, fcntl, hashlib, hmac, json, os, pathlib, subprocess, time
parser = argparse.ArgumentParser()
parser.add_argument('--config', required=True)
parser.add_argument('--status', action='store_true')
args = parser.parse_args()
config_path = pathlib.Path(args.config)
if config_path.stat().st_mode & 0o077:
    raise SystemExit('Sync config must have mode 0600')
config = json.loads(config_path.read_text())
lock = open(config_path.with_suffix('.lock'), 'w')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(0)
path = '/internal/status' if args.status else '/internal/refresh'
method = 'GET' if args.status else 'POST'
ts = str(int(time.time() * 1000))
sig = hmac.new(config['secret'].encode(), f'{ts}\n{method}\n{path}'.encode(), hashlib.sha256).hexdigest()
# Feed request headers via stdin, never the command line or environment.
request = f'url = "{config["url"]}{path}"\nrequest = "{method}"\nheader = "X-Sync-Time: {ts}"\nheader = "X-Sync-Signature: {sig}"\nheader = "X-Trading-Service: 1"\n'
status = {'attemptedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
try:
    response = subprocess.run(['curl', '--config', '-', '--silent', '--show-error', '--fail-with-body', '--max-time', '240'], input=request, text=True, capture_output=True, timeout=250)
    if response.returncode:
        raise RuntimeError(f'Synchronization HTTP/transport failure (curl {response.returncode})')
    data = json.loads(response.stdout)
    status.update(ok=True, result=data)
except Exception as error:
    status.update(ok=False, error=str(error)[:200])
output = config_path.with_name('last-status.json')
temporary = output.with_suffix('.tmp')
with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
    json.dump(status, stream, ensure_ascii=False)
os.replace(temporary, output)
print(json.dumps(status, ensure_ascii=False))
raise SystemExit(0 if status['ok'] else 1)
