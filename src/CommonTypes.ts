// Some type definitions will be hosted here to avoid circular dependency errors
import type Web3 from 'web3'
import {BitcoinNetworkType} from './BitcoinHelpers'
import type {Config as ElectrumConfig} from "./lib/ElectrumClient"
import type {FoundTransaction} from './BitcoinHelpers'
import type {Contract} from 'web3-eth-contract'
import type BN from "bn.js"


 export interface TBTCConfig {
     web3:Web3,
     bitcoinNetwork:BitcoinNetworkType,
     electrum:ElectrumConfig,
 }

 export interface RedemptionDetails{
    utxoValue:BN,
    redeemerOutputScript:string,
    requestedFee:BN,
    outpoint:string,
    digest:string
   }

export interface KeyPoint {
    x:HexString,
    y:HexString
}

 export interface DepositBaseClass {
    address:string;
    keepContract:Contract;
    publicKeyPoint: Promise<KeyPoint>
    getCurrentState():Promise<number>
    factory:any;
    contract:Contract;
    constructFundingProof(bitcoinTransaction:Omit<FoundTransaction, 'value'>, confirmations:number):Promise<[
        Buffer,
        Buffer,
        Buffer,
        Buffer,
        number,
        Buffer,
        string,
        Buffer
      ]>
    getLatestRedemptionDetails():Promise<null|RedemptionDetails>
 }