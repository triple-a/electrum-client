import * as BitcoinJS from 'bitcoinjs-lib';

import {
    ElectrumWS,
    ElectrumWSOptions,
    bytesToHex,
    hexToBytes,
} from '../electrum-ws/index';

import {
    Balance,
    PlainBlockHeader,
    PlainInput,
    PlainOutput,
    PlainTransaction,
    Receipt,
    PeerFeatures,
    Peer,
} from './types';

export type ElectrumApiOptions = {
    endpoint?: string,
    network?: BitcoinJS.Network,
    proxy?: boolean,
    token?: string,
    reconnect?: boolean;
}

export class ElectrumApi {
    private options: ElectrumApiOptions;
    private socket: ElectrumWS;

    constructor(options: Omit<ElectrumApiOptions, 'network'> & { network?: 'bitcoin' | 'testnet' | BitcoinJS.Network } = {}) {
        if (typeof options.network === 'string') {
            options.network = BitcoinJS.networks[options.network];
        }

        this.options = options as ElectrumApiOptions;

        const wsOptions: Partial<ElectrumWSOptions> = {};
        if ('proxy' in this.options) wsOptions.proxy = this.options.proxy;
        if ('token' in this.options) wsOptions.token = this.options.token;
        if ('reconnect' in this.options) wsOptions.reconnect = this.options.reconnect;

        this.socket = new ElectrumWS(this.options.endpoint, wsOptions);
    }

    public async getBalance(address: string): Promise<Balance> {
        return this.socket.request('blockchain.scripthash.get_balance', await this.addressToScriptHash(address));
    }

    public async getReceipts(address: string, isScriptHash = false): Promise<Receipt[]> {
        const receipts: Array<{height: number, tx_hash: string, fee?: number}> =
            await this.socket.request('blockchain.scripthash.get_history', isScriptHash ? address : await this.addressToScriptHash(address));

        return receipts.map((r) => ({
            blockHeight: r.height,
            transactionHash: r.tx_hash,
            ...(r.fee ? { fee: r.fee } : {}),
        }));
    }


    // TODO: Move into future ElectrumClient to take advantage of the current chain height to calculate confirmations and tx state.
    public async getHistory(address: string, sinceBlockHeight = 0, knownReceipts = [] as Receipt[], limit = Infinity) {
        // Prepare map of known transactions
        const knownTxs = new Map<string, Receipt>();
        if (knownReceipts) {
            for (const receipt of knownReceipts) {
                knownTxs.set(receipt.transactionHash, receipt);
            }
        }

        let history = await this.getReceipts(address);

        // Sort by height DESC to fetch newest txs first
        history.sort((a, b) => (b.blockHeight || Number.MAX_SAFE_INTEGER) - (a.blockHeight || Number.MAX_SAFE_INTEGER));

        // Reduce history to limit
        if (limit < Infinity) {
            history = history.slice(0, limit);
        }

        // Remove unwanted history
        if (sinceBlockHeight > 0) {
            const firstUnwantedHistoryIndex = history.findIndex(receipt => receipt.blockHeight > 0 && receipt.blockHeight < sinceBlockHeight);
            history = history.slice(0, firstUnwantedHistoryIndex);
        }

        const blockHeaders = new Map<number, PlainBlockHeader>();

        // Fetch transactions
        const txs = [];
        for (const { transactionHash, blockHeight } of history) {
            const knownTx = knownTxs.get(transactionHash);
            if (knownTx && knownTx.blockHeight === Math.max(blockHeight, 0)) continue; // Ignore blockHeights of -1

            try {
                let blockHeader = blockHeaders.get(blockHeight);
                if (!blockHeader && blockHeight > 0) {
                    blockHeader = await this.getBlockHeader(blockHeight);
                    blockHeaders.set(blockHeight, blockHeader);
                }

                try {
                    // Validates merkle proof and includes block data in plain transaction
                    const tx = await this.getTransaction(transactionHash, blockHeader);
                    txs.push(tx);
                } catch (error) {
                    console.warn(error);
                    continue;
                }
            } catch (error) {
                console.warn(error);
                return txs;
            }
        }

        return txs;
    }

    public async getTransaction(hash: string, heightOrBlockHeader?: number | PlainBlockHeader): Promise<PlainTransaction> {
        let blockHeader;
        if (typeof heightOrBlockHeader === 'object') {
            blockHeader = heightOrBlockHeader;
        } else if (typeof heightOrBlockHeader === 'number' && heightOrBlockHeader > 0) {
            blockHeader = await this.getBlockHeader(heightOrBlockHeader);
        }

        if (blockHeader) {
            // Proof transaction
            const transactionMerkleRoot = await this.getTransactionMerkleRoot(hash, blockHeader.blockHeight);
            if (transactionMerkleRoot !== blockHeader.merkleRoot) {
                throw new Error(`Invalid merkle proof for given block height: ${hash}, ${blockHeader.blockHeight}`);
            }
        }

        const raw: string = await this.socket.request('blockchain.transaction.get', hash);

        return this.transactionToPlain(raw, blockHeader);
    }

    public async getTransactionMerkleRoot(hash: string, height: number): Promise<string> {
        type MerkleProof = {
            block_height: number;
            merkle: string[],
            pos: number,
        };

        const proof: MerkleProof = await this.socket.request('blockchain.transaction.get_merkle', hash, height);

        // All hashes that we have (tx hash and merkle path hashes) are in little-endian byte order and must be reversed into big-endian as we go along
        let i = proof.pos;
        let node = hexToBytes(hash).reverse();
        for (const pairHash of proof.merkle) {
            const pairNode = hexToBytes(pairHash).reverse();

            const concatenated = new Uint8Array(i % 2 === 0
                ? [...node, ...pairNode] // even index
                : [...pairNode, ...node] // uneven index
            );

            // Double SHA256 hash
            node = new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.digest('SHA-256', concatenated)));

            // Update index for the next tree level
            i = Math.floor(i / 2);
        }

        // Reverse back into little-endian byte order
        return bytesToHex(node.reverse());
    }

    public async getBlockHeader(height: number): Promise<PlainBlockHeader> {
        const raw: string = await this.socket.request('blockchain.block.header', height);

        return this.blockHeaderToPlain(raw, height);
    }

    public async getFeeHistogram(): Promise<Array<[number, number]>> {
        return this.socket.request('mempool.get_fee_histogram');
    }

    public async broadcastTransaction(rawTx: string): Promise<PlainTransaction> {
        const tx = this.transactionToPlain(rawTx);
        const hash = await this.socket.request('blockchain.transaction.broadcast', rawTx);
        if (hash === tx.transactionHash) return tx;
        else throw new Error(hash); // Protocol v1.0 returns errors as the result string
    }

    public async subscribeReceipts(address: string, callback: (receipts: Receipt[]) => any) {
        this.socket.subscribe(
            'blockchain.scripthash',
            async (scriptHash: string, status: string | null) => {
                callback(!status ? [] : await this.getReceipts(scriptHash, true));
            },
            await this.addressToScriptHash(address),
        );
    }

    public async subscribeHeaders(callback: (header: PlainBlockHeader) => any) {
        this.socket.subscribe('blockchain.headers', async (headerInfo: {height: number, hex: string}) => {
            callback(this.blockHeaderToPlain(headerInfo.hex, headerInfo.height));
        });
    }

    public async getFeatures(): Promise<PeerFeatures> {
        return this.socket.request('server.features');
    }

    public async getPeers(): Promise<Peer[]> {
        const peers: Array<[string, string, string[]]> = await this.socket.request('server.peers.subscribe');

        return peers.map(peer => {
            const ip = peer[0];
            const host = peer[1];

            let version: string = '';
            let pruningLimit: number | undefined = undefined;
            let tcp: number | null = null;
            let ssl: number | null = null;
            let wss: number | null = null;

            for (const meta of peer[2]) {
                switch (meta.charAt(0)) {
                    case 'v': version = meta.substring(1); break;
                    case 'p': pruningLimit = Number.parseInt(meta.substring(1), 10); break;
                    case 't': {
                        if (meta.substring(1).length === 0) {
                            // An omitted port number means default port
                            switch (this.options.network || BitcoinJS.networks.bitcoin) {
                                case BitcoinJS.networks.testnet: tcp = 60001; break;
                                default: tcp = 50001; break; // mainnet (bitcoin)
                            }
                        } else {
                            tcp = Number.parseInt(meta.substring(1), 10);
                        }
                    } break;
                    case 's': {
                        if (meta.substring(1).length === 0) {
                            // An omitted port number means default port
                            switch (this.options.network || BitcoinJS.networks.bitcoin) {
                                case BitcoinJS.networks.testnet: ssl = 60002; break;
                                default: ssl = 50002; break; // mainnet (bitcoin)
                            }
                        } else {
                            ssl = Number.parseInt(meta.substring(1), 10);
                        }
                    } break;
                    case 'w': {
                        if (meta.substring(1).length === 0) {
                            // An omitted port number means default port
                            switch (this.options.network || BitcoinJS.networks.bitcoin) {
                                case BitcoinJS.networks.testnet: wss = 60004; break;
                                default: wss = 50004; break; // mainnet (bitcoin)
                            }
                        } else {
                            wss = Number.parseInt(meta.substring(1), 10);
                        }
                    } break;
                }
            }

            return {
                ip,
                host,
                version,
                pruningLimit,
                ports: {
                    tcp,
                    ssl,
                    wss,
                },
            };
        });
    }

    transactionToPlain(tx: string | BitcoinJS.Transaction, plainHeader?: PlainBlockHeader): PlainTransaction {
        if (typeof tx === 'string') tx = BitcoinJS.Transaction.fromHex(tx);

        const inputs = tx.ins.map((input: BitcoinJS.TxInput, index: number) => this.inputToPlain(input, index));
        const outputs = tx.outs.map((output: BitcoinJS.TxOutput, index: number) => this.outputToPlain(output, index));

        const plain: PlainTransaction = {
            transactionHash: tx.getId(),
            inputs,
            outputs,
            version: tx.version,
            vsize: tx.virtualSize(),
            isCoinbase: tx.isCoinbase(),
            weight: tx.weight(),
            blockHash: null,
            blockHeight: null,
            timestamp: null,
            // Sequence constant from https://github.com/bitcoin/bips/blob/master/bip-0125.mediawiki#summary
            replaceByFee: inputs.some(input => input.sequence < 0xfffffffe),
        };

        if (plainHeader) {
            plain.blockHash = plainHeader.blockHash;
            plain.blockHeight = plainHeader.blockHeight;
            plain.timestamp = plainHeader.timestamp;
        }

        return plain;
    }

    inputToPlain(input: BitcoinJS.TxInput, index: number): PlainInput {
        return {
            script: bytesToHex(input.script),
            transactionHash: bytesToHex(new Uint8Array(input.hash).reverse()),
            address: this.deriveAddressFromInput(input) || null,
            witness: input.witness.map((buf) => {
                if (typeof buf === 'number') return buf;
                return bytesToHex(buf);
            }),
            index,
            outputIndex: input.index,
            sequence: input.sequence,
        };
    }

    outputToPlain(output: BitcoinJS.TxOutput, index: number): PlainOutput {
        return {
            script: bytesToHex(output.script),
            address: BitcoinJS.address.fromOutputScript(output.script, this.options.network),
            value: output.value,
            index,
        };
    }

    deriveAddressFromInput(input: BitcoinJS.TxInput): string | undefined {
        const chunks = (BitcoinJS.script.decompile(input.script) || []) as Buffer[];
        const witness = input.witness;

        // Legacy addresses P2PKH (1...)
        // a4453c9e224a0927f2909e49e3a97b31b5aa74a42d99de8cfcdaf293cb2ecbb7 0,1
        if (chunks.length === 2 && witness.length === 0) {
            return BitcoinJS.payments.p2pkh({
                pubkey: chunks[1],
                network: this.options.network,
            }).address;
        }

        // Nested SegWit P2SH(P2WPKH) (3...)
        // 6f4e12fa9e869c8721f2d747e042ff80f51c6757277df1563b54d4e9c9454ba0 0,1,2
        if (chunks.length === 1	&& witness.length === 2) {
            return BitcoinJS.payments.p2sh({
                redeem: BitcoinJS.payments.p2wpkh({
                    pubkey: witness[1],
                    network: this.options.network,
                }),
            }).address;
        }

        // Native SegWit P2WPKH (bc1...)
        // 3c89e220db701fed2813e0af033610044bc508d2de50cb4c420b8f3ad2d72c5c 0
        if (chunks.length === 0 && witness.length === 2) {
            return BitcoinJS.payments.p2wpkh({
                pubkey: witness[1],
                network: this.options.network,
            }).address;
        }

        // Legacy MultiSig P2SH(P2MS) (3...)
        // 80975cddebaa93aa21a6477c0d050685d6820fa1068a2731db0f39b535cbd369 0,1,2
        if (chunks.length > 2 && witness.length === 0) {
            const m = chunks.length - 2; // Number of signatures
            const pubkeys = BitcoinJS.script.decompile(chunks[chunks.length - 1])!
                .filter((n: number | Buffer) => typeof n !== 'number') as Buffer[];

            return BitcoinJS.payments.p2sh({
                redeem: BitcoinJS.payments.p2ms({
                    m,
                    pubkeys,
                    network: this.options.network,
                }),
            }).address;
        }

        // Nested SegWit MultiSig P2SH(P2WSH(P2MS)) (3...)
        // 80975cddebaa93aa21a6477c0d050685d6820fa1068a2731db0f39b535cbd369 3
        if (chunks.length === 1 && witness.length > 2) {
            const m = witness.length - 2; // Number of signatures
            const pubkeys = BitcoinJS.script.decompile(witness[witness.length - 1])!
                .filter((n: number | Uint8Array) => typeof n !== 'number') as Buffer[];

            return BitcoinJS.payments.p2sh({
                redeem: BitcoinJS.payments.p2wsh({
                    redeem: BitcoinJS.payments.p2ms({
                        m,
                        pubkeys,
                        network: this.options.network,
                    }),
                }),
            }).address;
        }

        // Native SegWit MultiSig P2WSH(P2MS) (bc1...)
        // 54a3e33efff4c508fa5c8ce7ccf4b08538a8fd2bf808b97ae51c21cf83df2dd1 0
        if (chunks.length === 0 && witness.length > 2) {
            const m = witness.length - 2; // Number of signatures
            const pubkeys = BitcoinJS.script.decompile(witness[witness.length - 1])!
                .filter((n: number | Uint8Array) => typeof n !== 'number') as Buffer[];

            return BitcoinJS.payments.p2wsh({
                redeem: BitcoinJS.payments.p2ms({
                    m,
                    pubkeys,
                    network: this.options.network,
                }),
            }).address;
        }

        console.error(new Error('Cannot decode address from input'));
        return undefined;
    }

    blockHeaderToPlain(header: string | BitcoinJS.Block, height: number): PlainBlockHeader {
        if (typeof header === 'string') header = BitcoinJS.Block.fromHex(header);

        return {
            blockHash: header.getId(),
            blockHeight: height,
            timestamp: header.timestamp,
            bits: header.bits,
            nonce: header.nonce,
            version: header.version,
            weight: header.weight(),
            prevHash: header.prevHash ? bytesToHex(new Uint8Array(header.prevHash).reverse()) : null,
            merkleRoot: header.merkleRoot ? bytesToHex(new Uint8Array(header.merkleRoot).reverse()) : null,
        };
    }


    private async addressToScriptHash(addr: string) {
        const outputScript = BitcoinJS.address.toOutputScript(addr, this.options.network);

        // Hash with SHA256
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', outputScript));

        // Convert reversed into HEX
        return bytesToHex(hash.reverse());
    }
}
