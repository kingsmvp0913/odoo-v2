const PORT_RANGE_START = 11000;
const PORT_RANGE_END = 11999;

function allocateForwardPort(usedPorts = []) {
  const used = new Set(usedPorts);
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('沒有可用的 VPN 轉發 port（11000-11999 已滿）');
}

function containerName(connId) {
  return `vpn-conn-${connId}`;
}

module.exports = { allocateForwardPort, containerName };
