/* eslint-disable no-await-in-loop */
const { buildPoseidon } = require('circomlibjs');
const { Scalar } = require('ffjavascript');

const ethers = require('ethers');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const MemDB = require('../../../src/zk-EVM/zkproverjs/memdb');
const SMT = require('../../../src/zk-EVM/zkproverjs/smt');
const stateUtils = require('../../../src/zk-EVM/helpers/state-utils');
const Constants = require('../../../src/zk-EVM/constants');
const { getValue } = require('../../../src/zk-EVM/helpers/db-key-value-utils');

const ZkEVMDB = require('../../../src/zk-EVM/zkevm-db');
const { setGenesisBlock } = require('./helpers/test-helpers');

describe('zkEVM-db Test', () => {
    let poseidon;
    let F;

    let testVectors;

    before(async () => {
        poseidon = await buildPoseidon();
        F = poseidon.F;
        testVectors = JSON.parse(fs.readFileSync(path.join(__dirname, './helpers/test-vector-data/state-transition.json')));
    });

    after(async () => {
        globalThis.curve_bn128.terminate(); // eslint-disable-line
    });

    it('Check zkEVMDB basic functions', async () => {
        const arity = 4;
        const chainIdSequencer = 100;
        const sequencerAddress = '0x0000000000000000000000000000000000000000';
        const genesisRoot = F.e('0x0000000000000000000000000000000000000000000000000000000000000000');
        const localExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';
        const globalExitRoot = '0x0000000000000000000000000000000000000000000000000000000000000000';

        const db = new MemDB(F);

        // create a zkEVMDB and build a batch
        const zkEVMDB = await ZkEVMDB.newZkEVM(db, chainIdSequencer, arity, poseidon, sequencerAddress, genesisRoot);
        // check intiialize parameters
        const chainIDDB = await getValue(Constants.DB_SeqChainID, db);
        const arityDB = await getValue(Constants.DB_Arity, db);

        expect(Scalar.toNumber(chainIDDB)).to.be.equal(chainIdSequencer);
        expect(Scalar.toNumber(arityDB)).to.be.equal(arity);

        // build an empty batch
        const batch = await zkEVMDB.buildBatch(localExitRoot, globalExitRoot);
        await batch.executeTxs();
        const newRoot = batch.currentRoot;
        expect(newRoot).to.be.equal(genesisRoot);

        // checks DB state previous consolidate zkEVMDB
        try {
            await getValue(Constants.DB_LastBatch, db);
            throw new Error('DB should be empty');
        } catch (error) {
            expect(error.toString().includes("Cannot read property 'length' of undefined")).to.be.equal(true);
        }

        const batchNum = Scalar.e(0);
        expect(zkEVMDB.lastBatch).to.be.equal(batchNum);

        // consoldate state
        await zkEVMDB.consolidate(batch);

        // checks after consolidate zkEVMDB
        expect(zkEVMDB.lastBatch).to.be.equal(Scalar.add(batchNum, 1));
        expect(zkEVMDB.stateRoot).to.be.equal(genesisRoot);

        // check agains DB
        const lastBatchDB = await getValue(Constants.DB_LastBatch, db, F);
        const stateRootDB = await getValue(Scalar.add(Constants.DB_Batch, lastBatchDB), db, F);
        expect(lastBatchDB).to.be.equal(Scalar.add(batchNum, 1));
        expect(F.e(stateRootDB)).to.be.deep.equal(zkEVMDB.stateRoot);

        // Try to import the DB
        const zkEVMDBImported = await ZkEVMDB.newZkEVM(db, null, null, poseidon, sequencerAddress, null);

        expect(zkEVMDB.lastBatch).to.be.equal(zkEVMDBImported.lastBatch);
        expect(zkEVMDB.stateRoot).to.be.deep.equal(zkEVMDBImported.stateRoot);
        expect(zkEVMDB.arity).to.be.equal(zkEVMDBImported.arity);
        expect(zkEVMDB.chainID).to.be.equal(zkEVMDBImported.chainID);
    });

    it('Check zkEVMDB when consolidate a batch', async () => {
        const {
            arity,
            genesis,
            expectedOldRoot,
            txs,
            expectedNewRoot,
            chainIdSequencer,
            sequencerAddress,
            localExitRoot,
            globalExitRoot,
        } = testVectors[0];

        const db = new MemDB(F);
        const smt = new SMT(db, arity, poseidon, poseidon.F);

        const walletMap = {};
        const addressArray = [];
        const amountArray = [];
        const nonceArray = [];

        // create genesis block
        for (let j = 0; j < genesis.length; j++) {
            const {
                address, pvtKey, balance, nonce,
            } = genesis[j];

            const newWallet = new ethers.Wallet(pvtKey);
            expect(address).to.be.equal(newWallet.address);

            walletMap[address] = newWallet;
            addressArray.push(address);
            amountArray.push(Scalar.e(balance));
            nonceArray.push(Scalar.e(nonce));
        }

        // set genesis block
        const genesisRoot = await setGenesisBlock(addressArray, amountArray, nonceArray, smt);
        for (let j = 0; j < addressArray.length; j++) {
            const currentState = await stateUtils.getState(addressArray[j], smt, genesisRoot);

            expect(currentState.balance).to.be.equal(amountArray[j]);
            expect(currentState.nonce).to.be.equal(nonceArray[j]);
        }

        expect(F.toString(genesisRoot)).to.be.equal(expectedOldRoot);

        // build, sign transaction and generate rawTxs
        // rawTxs would be the calldata inserted in the contract
        const txProcessed = [];
        const rawTxs = [];
        for (let j = 0; j < txs.length; j++) {
            const txData = txs[j];
            const tx = {
                to: txData.to,
                nonce: txData.nonce,
                value: ethers.utils.parseEther(txData.value),
                gasLimit: txData.gasLimit,
                gasPrice: ethers.utils.parseUnits(txData.gasPrice, 'gwei'),
                chainId: txData.chainId,
            };

            try {
                let rawTx = await walletMap[txData.from].signTransaction(tx);
                expect(rawTx).to.equal(txData.rawTx);

                if (txData.encodeInvalidData) {
                    rawTx = rawTx.slice(0, -6);
                }
                rawTxs.push(rawTx);
                txProcessed.push(txData);
            } catch (error) {
                expect(txData.rawTx).to.equal(undefined);
            }
        }

        // create a zkEVMDB and build a batch
        const zkEVMDB = await ZkEVMDB.newZkEVM(db, chainIdSequencer, arity, poseidon, sequencerAddress, genesisRoot);
        const batch = await zkEVMDB.buildBatch(localExitRoot, globalExitRoot);
        for (let j = 0; j < rawTxs.length; j++) {
            batch.addRawTx(rawTxs[j]);
        }

        // execute the transactions added to the batch
        await batch.executeTxs();

        const newRoot = batch.currentRoot;
        expect(F.toString(newRoot)).to.be.equal(expectedNewRoot);

        // checks previous consolidate zkEVMDB
        try {
            await getValue(Constants.DB_LastBatch, db, F);
            throw new Error('DB should be empty');
        } catch (error) {
            expect(error.toString().includes("Cannot read property 'length' of undefined")).to.be.equal(true);
        }

        const batchNum = Scalar.e(0);
        expect(zkEVMDB.lastBatch).to.be.equal(batchNum);
        expect(F.toString(zkEVMDB.stateRoot)).to.be.equal(expectedOldRoot);

        // consoldate state
        await zkEVMDB.consolidate(batch);

        // checks after consolidate zkEVMDB
        expect(zkEVMDB.lastBatch).to.be.equal(Scalar.add(batchNum, 1));
        expect(F.toString(zkEVMDB.stateRoot)).to.be.equal(expectedNewRoot);

        const lastBatchDB = await getValue(Constants.DB_LastBatch, db, F);

        expect(lastBatchDB).to.be.equal(Scalar.add(batchNum, 1));

        const stateRootDB = await getValue(Scalar.add(Constants.DB_Batch, lastBatchDB), db, F);
        expect(F.e(stateRootDB)).to.be.deep.equal(zkEVMDB.stateRoot);
    });
});