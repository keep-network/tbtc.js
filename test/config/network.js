export const electrumConfig = {
  main: {
    server: "electrumx-server.tbtc.network",
    port: 8443,
    protocol: "wss"
  },
  testnet: {
    server: "electrumx-server.test.tbtc.network",
    port: 8443,
    protocol: "wss"
  },
  regtest: {
    server: "127.0.0.1",
    port: 50003,
    protocol: "ws"
  }
}
