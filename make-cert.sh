#!/bin/sh
# Creates the HTTPS certificate for this laptop's current network addresses.
# Run it again whenever the laptop's address changes (new Wi-Fi network).
set -e
cd "$(dirname "$0")"
mkdir -p certs
cd certs

# Our own small certificate authority, created once. Importing ca.pem into a
# browser removes the "not private" warning on that device.
if [ ! -f ca.pem ] || [ ! -f ca-key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout ca-key.pem -out ca.pem -subj "/CN=VoteAttawhid Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  echo "Created certificate authority: certs/ca.pem"
fi

SAN="DNS:localhost,IP:127.0.0.1"
for ip in $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1); do
  SAN="$SAN,IP:$ip"
done
[ -n "$1" ] && SAN="$SAN,$1"

openssl req -newkey rsa:2048 -nodes -keyout key.pem -out server.csr -subj "/CN=VoteAttawhid" 2>/dev/null
printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$SAN" > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -days 365 -out cert.pem -extfile ext.cnf 2>/dev/null
rm -f server.csr ext.cnf
chmod 600 key.pem ca-key.pem

echo "Certificate created for: $SAN"
echo "Restart the app: node server.js"
