import type {Options} from 'web3-eth-contract'

declare module 'web3-eth-contract' {
    export interface Options {
        handleRevert:boolean
    }
}