declare module "bcoin/lib/bcoin-browser.js" {
    export class Outpoint{
        static fromRaw(data:Buffer):Outpoint
    }
    class Witness {
        fromItems(items:Buffer[]):Witness
    }
    export class Input{
        static fromOptions(options:{
            prevout: Outpoint,
            sequence: number,
            script?:any,
            witness?:any
          }):Input
          witness:Witness
    }
    export class TX{
        static fromOptions(options:{
            version?:number,
            locktime?:number,
            inputs:Input[],
            outputs:Output[]
        }):TX
        toRaw():Buffer
        static fromRaw(data:Buffer|string, enc?:string):TX
        clone():TX
        inputs:Input[]
    }
    export class Output{
        static fromOptions(options:{
            value: number
        } & ({
            script: Buffer
          }|{
            address:string
          })):Output
    }
}
declare module "bcrypto/lib/secp256k1.js" {
    class ECDSA{
        get size():number;
        signatureNormalize(sig:any):any;
        publicKeyImport(json:Object, compress:any):any
    }
    const ECDSAimpl:ECDSA
    export default ECDSAimpl;
}
declare module "bcrypto/lib/internal/signature.js" {}
declare module "bcoin/lib/primitives/index.js" {
    export class KeyRing{
        static fromKey(key:Buffer, compress?:boolean):KeyRing;
        // getKeyHash is a little hard to type right, as the return type depends on the input parameter
        // but given that it's only called without arguments in the case we will only add types for that
        // See https://github.com/bcoin-org/bcoin/blob/master/lib/primitives/keyring.js#L566
        getKeyHash():Buffer;
    }
}
declare module "bcoin/lib/script/index.js" {
    type network = `main`|`testnet`|`regtest`|`segnet4`|'simnet'
    class Address{
        toBech32(network:network):string
        toString(network:network):string
    }

    export class Script{
        static fromAddress(address:string):Script;
        static fromProgram(version:number, data:Buffer):Script;
        static hashType:{ ALL: 1, NONE: 2, SINGLE: 3, ANYONECANPAY: 128 };
        getWitnessPubkeyhash():Buffer|null;
        toRaw():Buffer;
        getAddress():Address
    }
}

declare module "bcrypto/lib/internal/signature.js" {
    export default class {
        constructor(size:number, r:Buffer, s:Buffer)
        static toDER(raw:Buffer, size:number):Buffer
        encode(size:number):Buffer 
    }
}

type HexString=string