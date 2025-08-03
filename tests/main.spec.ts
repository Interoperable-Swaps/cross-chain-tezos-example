import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'

import Sdk, { Immutables } from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'
import {ChainConfig, config} from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver'
import {EscrowFactory} from './escrow-factory'
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'

import taquito from '@taquito/taquito';
import InMemorySigner  from "@taquito/signer";
import axios from 'axios';

const {Address} = Sdk

jest.setTimeout(1000 * 60)

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

const userTezosPk = 'edskRoVqVCvrSDmp3Dn2XpiimC5MXL2ffYK7Dvv6sCq7H1DTUxustDJPJpfVxhfGNpSaKvMEM9rYnupeE9FpG7nviEWCgr2ggP';
const resolverTezosPk = 'edskRpRBXgeb49dQKLteppmKFikqHkk6FBR3VgM626rgRaCNLbnByfmfjTM6xeJMDoaKvTNW2K1HGydUtHUT3tuJg8srX2ChTi';

export const tezosTokenContractAddress = "KT1WvwSEk2muVzyWeCH6tEntUSfn89QQRoLH";

export const tezosEscrowSrcFactoryContractAddress =
  "KT1QchTYqYu7tw7hrPuX9ED8WhQeJtpYXViz";

export const tezosEscrowDstFactoryContractAddress =
  "KT18hT9tJ1qXRpNg3tj7QFbNsddDHv1qgipG";


// eslint-disable-next-line max-lines-per-function
describe('Resolving example', () => {
    const srcChainId = config.chain.source.chainId
    const dstChainId = config.chain.destination.chainId

    type Chain = {
        node?: CreateServerReturnType | undefined
        provider: JsonRpcProvider
        escrowFactory: string
        resolver: string
    }

    let src: Chain
    let dst: Chain

    let srcChainUser: Wallet
    let dstChainUser: any
    let srcChainResolver: Wallet
    let dstChainResolver: any

    let srcFactory: EscrowFactory
    let dstFactory: any

    let srcResolverContract: Wallet

    let srcTimestamp: bigint

    async function increaseTime(t: number): Promise<void> {
        await Promise.all([src].map((chain) => chain.provider.send('evm_increaseTime', [t])))
    }

    beforeAll(async () => {

        ;[src] = await Promise.all([initChain(config.chain.source)])

        srcChainUser = new Wallet(userPk, src.provider)

        
        dstChainUser = new taquito.TezosToolkit("https://ghostnet.smartpy.io");

        const userSigner:any = await InMemorySigner.InMemorySigner.fromSecretKey(userTezosPk);

        dstChainUser.setProvider({ signer: userSigner });

        srcChainResolver = new Wallet(resolverPk, src.provider)

        dstChainResolver = new taquito.TezosToolkit("https://ghostnet.smartpy.io");

        const resolverSigner:any = await InMemorySigner.InMemorySigner.fromSecretKey(resolverTezosPk);

        dstChainResolver.setProvider({ signer: resolverSigner});

        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)

        dstFactory = await dstChainResolver.contract.at(tezosEscrowDstFactoryContractAddress);

        // get 1000 USDC for user in SRC chain and approve to LOP
        await srcChainUser.topUpFromDonor(
            config.chain.source.tokens.USDC.address,
            config.chain.source.tokens.USDC.donor,
            parseUnits('1000', 6)
        )
        await srcChainUser.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        )

        // get 2000 USDC for resolver in DST chain
        srcResolverContract = await Wallet.fromAddress(src.resolver, src.provider)
        
        // top up contract for approve

        const tezosTokenContract = await dstChainResolver.contract.at(tezosTokenContractAddress);

        await tezosTokenContract.methods.approve("KT18hT9tJ1qXRpNg3tj7QFbNsddDHv1qgipG", 10000);

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    async function getBalances(
        srcToken: string,
        dstToken: string
    ): Promise<{src: {user: bigint; resolver: bigint}; dst: {user: bigint; resolver: bigint}}> {
        
        const tezosTokenContract = await dstChainResolver.contract.at(tezosTokenContractAddress);

        const storage:any = await tezosTokenContract.storage();

        const userKeyHash = await dstChainUser.signer.publicKeyHash();

        const resolverKeyHash = await dstChainResolver.signer.publicKeyHash();

        const userBalance = await storage.ledger.get(userKeyHash);

        const resolverBalance = await storage.ledger.get(resolverKeyHash);
        
        return {
            src: {
                user: await srcChainUser.tokenBalance(srcToken),
                resolver: await srcResolverContract.tokenBalance(srcToken)
            },
            dst: {
                user: userBalance.balance.toNumber(),
                resolver: resolverBalance.balance.toNumber()
            }
        }
    }

    afterAll(async () => {
        src.provider.destroy()
        await Promise.all([src.node?.stop()])
    })

    // eslint-disable-next-line max-lines-per-function
    describe('Fill', () => {
        it('should swap Ethereum USDC -> Bsc USDC. Single fill only', async () => {
            const initialBalances = await getBalances(
                config.chain.source.tokens.USDC.address,
                config.chain.destination.tokens.USDC.address
            )

            console.log('Initial balances:', initialBalances);

            // User creates order
            const secret = uint8ArrayToHex(randomBytes(32)) // note: use crypto secure random number in real world
            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('100', 6),
                    takingAmount: parseUnits('99', 6),
                    makerAsset: new Address(config.chain.source.tokens.USDC.address),
                    takerAsset: new Address(config.chain.destination.tokens.USDC.address)
                },
                {
                    hashLock: Sdk.HashLock.forSingleFill(secret),
                    timeLocks: Sdk.TimeLocks.new({
                        srcWithdrawal: 10n, // 10sec finality lock for test
                        srcPublicWithdrawal: 220n, // 2m for private withdrawal
                        srcCancellation: 421n, // 1sec public withdrawal
                        srcPublicCancellation: 522n, // 1sec private cancellation
                        dstWithdrawal: 10n, // 10sec finality lock for test
                        dstPublicWithdrawal: 100n, // 100sec private withdrawal
                        dstCancellation: 101n // 1sec public withdrawal
                    }),
                    srcChainId,
                    dstChainId,
                    srcSafetyDeposit: 10000000n,
                    dstSafetyDeposit: 10000000n
                },
                {
                    auction: new Sdk.AuctionDetails({
                        initialRateBump: 0,
                        points: [],
                        duration: 120n,
                        startTime: srcTimestamp
                    }),
                    whitelist: [
                        {
                            address: new Address(src.resolver),
                            allowFrom: 0n
                        }
                    ],
                    resolvingStartTime: 0n
                },
                {
                    nonce: Sdk.randBigInt(UINT_40_MAX),
                    allowPartialFills: false,
                    allowMultipleFills: false
                }
            )

            const signature = await srcChainUser.signOrder(srcChainId, order)
            const orderHash = order.getOrderHash(srcChainId)
            // // Resolver fills order
            const resolverContract = new Resolver(src.resolver, "")

            console.log(`[${srcChainId}]`, `Filling order ${orderHash}`)

            const fillAmount = order.makingAmount
            const {txHash: orderFillHash, blockHash: srcDeployBlock} = await srcChainResolver.send(
                resolverContract.deploySrc(
                    srcChainId,
                    order,
                    signature,
                    Sdk.TakerTraits.default()
                        .setExtension(order.extension)
                        .setAmountMode(Sdk.AmountMode.maker)
                        .setAmountThreshold(order.takingAmount),
                    fillAmount
                )
            )

            console.log(`[${srcChainId}]`, `Order ${orderHash} filled for ${fillAmount} in tx ${orderFillHash}`)

            const srcEscrowEvent = await srcFactory.getSrcDeployEvent(srcDeployBlock)

            const dstImmutables = srcEscrowEvent[0]
                .withComplement(srcEscrowEvent[1]);

            console.log(dstImmutables);

            console.log(`[${dstChainId}]`, `Depositing ${dstImmutables.amount} for order ${orderHash}`)

            // Deploying Dst Escrow Factory 

            const tezosTokenContract = await dstChainResolver.contract.at(tezosTokenContractAddress);

            const approveOperation = await tezosTokenContract.methods.approve(tezosEscrowDstFactoryContractAddress, dstImmutables.amount).send();

            console.log("Resolver Approve operation:", approveOperation.hash);

            const tezosEscrowDstFactory = await dstChainResolver.contract.at(tezosEscrowDstFactoryContractAddress);

            // Prevent Nounce in PAST ERROR
            await sleep(2000 * 6);

            // DstCancellation nat
            // DstPublicWithdrawal nat
            // DstWithdrawal nat
            // amount nat
            // hash bytes
            // maker address
            // orderHash bytes
            // safetyDeposit mutez
            // srcCancellationTimestamp timestamp
            // taker address
            // token address
            // tokenId nat
            // tokenType bool

            const DstCancellation = 2000; 
            const DstPublicWithdrawal = 1000; 
            const DstWithdrawal = 10;

            const makerAddress = await dstChainUser.signer.publicKeyHash();
            const takerAddress = await dstChainResolver.signer.publicKeyHash();
            const srcCancellationTimestamp = 100;

            // console.log(DstCancellation,
            //     DstPublicWithdrawal,
            //     DstWithdrawal,
            //     dstImmutables.hashLock.toString(),
            //     makerAddress,
            //     dstImmutables.orderHash,
            //     dstImmutables.safetyDeposit,
            //     srcCancellationTimestamp,
            //     takerAddress,
            //     tezosTokenContractAddress,
            //     0,
            //     false);

            const deployOperation = await tezosEscrowDstFactory.methods.deployEscrowDst(
                DstCancellation,
                DstPublicWithdrawal,
                DstWithdrawal,
                dstImmutables.amount,
                dstImmutables.hashLock.toString(),
                makerAddress,
                dstImmutables.orderHash,
                dstImmutables.safetyDeposit,
                srcCancellationTimestamp,
                takerAddress,
                tezosTokenContractAddress,
                0,
                false
            ).send({amount: 10000000, mutez: true});

            console.log("Dst Escrow Factory deploy operation:", deployOperation.hash);
    
            const ESCROW_SRC_IMPLEMENTATION = await srcFactory.getSourceImpl()

            const srcEscrowAddress = new Sdk.EscrowFactory(new Address(src.escrowFactory)).getSrcEscrowAddress(
                srcEscrowEvent[0],
                ESCROW_SRC_IMPLEMENTATION
            )

            // Getting Deployment Address from exnternal API with validation 
            await sleep(2000 * 5);

            const api_resonse = await axios.get(
            `https://api.ghostnet.tzkt.io/v1/contracts/events?contract=KT18hT9tJ1qXRpNg3tj7QFbNsddDHv1qgipG&tag=deployedDstEscrow&limit=1&sort.desc=id`,
            );

            console.log("API response:", api_resonse.data);
            
            let dstEscrowAddress = "";

            if (`0x${api_resonse.data[0].payload.orderHash}` != dstImmutables.hashLock.toString()) {
                console.log("Event Not Found");
            } else {
                console.log(api_resonse.data[0]);
                dstEscrowAddress = api_resonse.data[0].payload.newEscrow;
                console.log("Deployed Escrow", dstEscrowAddress);
            }            
        
            // User shares key after validation of dst escrow deployment
            console.log(`[${dstChainId}]`, `Withdrawing funds for user from ${dstEscrowAddress}`)
            
            const dstEscrowContract = await dstChainResolver.contract.at(dstEscrowAddress);

            const userWithdrawOperation = await dstEscrowContract.methods.withdraw(secret).send();

            console.log("Users funds withdraw on destination chain", userWithdrawOperation.hash);

            console.log(`[${srcChainId}]`, `Withdrawing funds for resolver from ${srcEscrowAddress}`)
            const {txHash: resolverWithdrawHash} = await srcChainResolver.send(
                resolverContract.withdraw('src', srcEscrowAddress, secret, srcEscrowEvent[0])
            )
            console.log(
                `[${srcChainId}]`,
                `Withdrew funds for resolver from ${srcEscrowAddress} to ${src.resolver} in tx ${resolverWithdrawHash}`
            )

            // const resultBalances = await getBalances(
            //     config.chain.source.tokens.USDC.address,
            //     config.chain.destination.tokens.USDC.address
            // )

            // // user transferred funds to resolver on source chain
            // expect(initialBalances.src.user - resultBalances.src.user).toBe(order.makingAmount)
            // expect(resultBalances.src.resolver - initialBalances.src.resolver).toBe(order.makingAmount)
            // // resolver transferred funds to user on destination chain
            // expect(resultBalances.dst.user - initialBalances.dst.user).toBe(order.takingAmount)
            // expect(initialBalances.dst.resolver - resultBalances.dst.resolver).toBe(order.takingAmount)
        })


})

})

async function initChain(
    cnf: ChainConfig
): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string}> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

    // deploy EscrowFactory
    const escrowFactory = await deploy(
        factoryContract,
        [
            cnf.limitOrderProtocol,
            cnf.wrappedNative, // feeToken,
            Address.fromBigInt(0n).toString(), // accessToken,
            deployer.address, // owner
            60 * 30, // src rescue delay
            60 * 30 // dst rescue delay
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Escrow factory contract deployed to`, escrowFactory)

    // deploy Resolver contract
    const resolver = await deploy(
        resolverContract,
        [
            escrowFactory,
            cnf.limitOrderProtocol,
            computeAddress(resolverPk) // resolver as owner of contract
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Resolver contract deployed to`, resolver)

    return {node: node, provider, resolver, escrowFactory}
}

async function getProvider(cnf: ChainConfig): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider}> {
    if (!cnf.createFork) {
        return {
            provider: new JsonRpcProvider(cnf.url, cnf.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            })
        }
    }

    const node = createServer({
        instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}),
        limit: 1
    })
    await node.start()

    const address = node.address()
    assert(address)

    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })

    return {
        provider,
        node
    }
}

/**
 * Deploy contract and return its address
 */
async function deploy(
    json: {abi: any; bytecode: any},
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()

    return await deployed.getAddress()
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
