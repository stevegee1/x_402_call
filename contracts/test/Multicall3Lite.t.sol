// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Multicall3Lite} from "../src/Multicall3Lite.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract Reverter {
    function boom() external pure {
        revert("boom");
    }
}

contract Multicall3LiteTest is Test {
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;
    Multicall3Lite mc;
    MockUSDC usdc;
    address reverter;
    address holder = makeAddr("holder");

    function setUp() public {
        vm.etch(MULTICALL3, type(Multicall3Lite).runtimeCode);
        mc = Multicall3Lite(MULTICALL3);
        usdc = new MockUSDC();
        usdc.mint(holder, 123);
        reverter = address(new Reverter());
    }

    // The exact selectors the x402 EVM library and viem encode against.
    function test_selectorsMatchMulticall3() public pure {
        assertEq(Multicall3Lite.tryAggregate.selector, bytes4(keccak256("tryAggregate(bool,(address,bytes)[])")));
        assertEq(Multicall3Lite.aggregate3.selector, bytes4(keccak256("aggregate3((address,bool,bytes)[])")));
        assertEq(Multicall3Lite.aggregate.selector, bytes4(keccak256("aggregate((address,bytes)[])")));
    }

    function _calls() internal view returns (Multicall3Lite.Call[] memory c) {
        c = new Multicall3Lite.Call[](3);
        c[0] = Multicall3Lite.Call(address(usdc), abi.encodeCall(usdc.balanceOf, (holder)));
        c[1] = Multicall3Lite.Call(reverter, abi.encodeCall(Reverter.boom, ()));
        c[2] = Multicall3Lite.Call(address(usdc), abi.encodeCall(usdc.authorizationState, (holder, bytes32(0))));
    }

    function test_tryAggregateReportsEachResult() public {
        Multicall3Lite.Result[] memory r = mc.tryAggregate(false, _calls());
        assertEq(r.length, 3);
        assertTrue(r[0].success);
        assertEq(abi.decode(r[0].returnData, (uint256)), 123);
        assertFalse(r[1].success);
        assertTrue(r[2].success);
        assertFalse(abi.decode(r[2].returnData, (bool)));
    }

    function test_tryAggregateRequireSuccessReverts() public {
        vm.expectRevert("Multicall3: call failed");
        mc.tryAggregate(true, _calls());
    }

    function test_aggregate3HonoursAllowFailure() public {
        Multicall3Lite.Call3[] memory c = new Multicall3Lite.Call3[](2);
        c[0] = Multicall3Lite.Call3(address(usdc), false, abi.encodeCall(usdc.balanceOf, (holder)));
        c[1] = Multicall3Lite.Call3(reverter, true, abi.encodeCall(Reverter.boom, ()));
        Multicall3Lite.Result[] memory r = mc.aggregate3(c);
        assertTrue(r[0].success);
        assertFalse(r[1].success);
        c[1].allowFailure = false;
        vm.expectRevert("Multicall3: call failed");
        mc.aggregate3(c);
    }

    function test_aggregateReturnsBlockNumber() public {
        vm.roll(42);
        Multicall3Lite.Call[] memory c = new Multicall3Lite.Call[](1);
        c[0] = Multicall3Lite.Call(address(usdc), abi.encodeCall(usdc.balanceOf, (holder)));
        (uint256 bn, bytes[] memory ret) = mc.aggregate(c);
        assertEq(bn, 42);
        assertEq(abi.decode(ret[0], (uint256)), 123);
    }
}
