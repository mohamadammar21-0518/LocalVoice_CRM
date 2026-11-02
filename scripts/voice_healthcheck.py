"""Container readiness check; never prints the internal authentication token."""
import json
import os
import sys
import urllib.request

try:
    port = int(sys.argv[1])
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/health",
        headers={"X-Service-Token": os.getenv("VOICE_SERVICE_TOKEN", "")},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        ready = response.status == 200 and json.load(response).get("ok") is True
    sys.exit(0 if ready else 1)
except Exception:
    sys.exit(1)
