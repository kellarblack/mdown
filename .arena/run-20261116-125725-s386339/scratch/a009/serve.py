import os, sys, http.server, socketserver

ROOT = "/Users/kellarblack/Documents/Default Project/mdown"
PORT = 4931

# double fork so the server outlives the calling shell's process group
if os.fork():
    sys.exit(0)
os.setsid()
if os.fork():
    sys.exit(0)

os.chdir(ROOT)
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), http.server.SimpleHTTPRequestHandler) as httpd:
    httpd.serve_forever()
