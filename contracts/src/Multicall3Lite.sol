// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title Multicall3Lite
 * @notice TEST ONLY. The read-batching subset of Multicall3 (mds1/multicall3), ABI-compatible, for
 * installation at the canonical Multicall3 address 0xcA11bde05977b3631167028862bE2a173976CA11 on a
 * local anvil node. Base and Base Sepolia ship the real Multicall3 there; the x402 EVM library batches its
 * facilitator diagnostics (balance, nonce state, token name/version) through it, so without it a
 * local chain reports generic "simulation failed" reasons instead of the specific ones production sees.
 *
 * Only non-payable batching is provided (aggregate, tryAggregate, aggregate3); no value-forwarding
 * or block-info helpers.
 */
contract Multicall3Lite {
    struct Call {
        address target;
        bytes callData;
    }

    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate(Call[] calldata calls) external returns (uint256 blockNumber, bytes[] memory returnData) {
        blockNumber = block.number;
        returnData = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success, "Multicall3: call failed");
            returnData[i] = ret;
        }
    }

    function tryAggregate(bool requireSuccess, Call[] calldata calls) external returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (requireSuccess) require(success, "Multicall3: call failed");
            returnData[i] = Result(success, ret);
        }
    }

    function aggregate3(Call3[] calldata calls) external returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory ret) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, ret);
        }
    }
}
