Testing the mini-maintainer
===========================

Here are some basic field notes for testing the maintainer scenarios.

## Liquidations

```js
$ truffle console

# Adjust the development price feed.
feed = await ETHBTCPriceFeedMock.deployed()
feed.setValue('100000000000')

deposit = await Deposit.at("0xA962d2f5221A6A050FE8A4740F9D8EbD130EB58B")

# Check collateralisation level.
(await deposit.getCollateralizationPercentage()).toString()
```

## Signature fraud

 1. Create and fund deposit.
 2. Snapshot Ganache.
 3. Request redemption.
 4. Signature is broadcast by Keep.
 5. Revert to snapshot.
 6. Run maintainer to detect old signature, which is now unknown to contracts and constitutes fraud.

## Protocol timeouts

```sh
# Take snapshot.
curl -H "Content-Type: application/json" -X POST --data \
        '{"id":1337,"jsonrpc":"2.0","method":"evm_snapshot","params":[]}' \
        http://localhost:8545

# Increase EVM time.
curl -H "Content-Type: application/json" -X POST --data \
        '{"id":1337,"jsonrpc":"2.0","method":"evm_increaseTime","params":[7200]}' \
        http://localhost:8545

# Revert snapshot.
curl -H "Content-Type: application/json" -X POST --data \
        '{"id":1337,"jsonrpc":"2.0","method":"evm_revert","params":["0x3"]}' \
        http://localhost:8545
```