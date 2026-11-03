// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract Wallet1271 {
    address public immutable owner;

    constructor(address o) {
        owner = o;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = (uint8(sig[64]), bytes32(0), bytes32(0));
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
        }
        return ecrecover(hash, v, r, s) == owner ? this.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract MockUSDCTest is Test {
    /// Canonical Base Sepolia USDC: the e2e harness installs the mock here with anvil_setCode.
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    MockUSDC usdc;
    uint256 payerKey = 0xA11CE;
    address payer;
    address payTo = makeAddr("payTo");
    address relayer = makeAddr("facilitator");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        // Same path as the harness: runtime code only, no constructor, no initialised storage.
        vm.etch(BASE_SEPOLIA_USDC, type(MockUSDC).runtimeCode);
        usdc = MockUSDC(BASE_SEPOLIA_USDC);
        payer = vm.addr(payerKey);
        usdc.mint(payer, 10_000_000);
    }

    struct Auth {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    function _auth(uint256 value, bytes32 nonce) internal view returns (Auth memory) {
        return Auth(payer, payTo, value, block.timestamp - 600, block.timestamp + 120, nonce);
    }

    function _sign(uint256 key, bytes32 typehash, Auth memory a) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(typehash, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function _submit(Auth memory a, uint8 v, bytes32 r, bytes32 s) internal {
        vm.prank(relayer);
        usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    // ---- metadata / domain: must match what @x402/evm assumes for eip155:84532 ----

    function test_metadataMatchesBaseSepoliaUsdc() public view {
        assertEq(usdc.name(), "USDC");
        assertEq(usdc.version(), "2");
        assertEq(usdc.decimals(), 6);
    }

    function test_domainSeparatorIsStandardEip712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USDC"),
                keccak256("2"),
                uint256(84532),
                BASE_SEPOLIA_USDC
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
    }

    function test_domainSeparatorTracksChainId() public {
        bytes32 before = usdc.DOMAIN_SEPARATOR();
        vm.chainId(8453);
        assertTrue(usdc.DOMAIN_SEPARATOR() != before, "a signature for one chain must not be valid on another");
    }

    // ---- transferWithAuthorization ----

    function test_transferWithAuthorization_vrs() public {
        Auth memory a = _auth(33_000, keccak256("n1"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.expectEmit(address(usdc));
        emit AuthorizationUsed(payer, a.nonce);
        vm.expectEmit(address(usdc));
        emit Transfer(payer, payTo, 33_000);
        _submit(a, v, r, s);
        assertEq(usdc.balanceOf(payTo), 33_000);
        assertEq(usdc.balanceOf(payer), 10_000_000 - 33_000);
        assertEq(usdc.balanceOf(relayer), 0, "relayer pays gas, never receives funds");
        assertTrue(usdc.authorizationState(payer, a.nonce));
    }

    function test_transferWithAuthorization_bytesSignature() public {
        Auth memory a = _auth(66_000, keccak256("n2"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.prank(relayer);
        usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(payTo), 66_000);
    }

    function test_replayIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n3"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        _submit(a, v, r, s);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        _submit(a, v, r, s);
        assertEq(usdc.balanceOf(payTo), 33_000);
    }

    function test_expiredIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n4"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.warp(a.validBefore);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        _submit(a, v, r, s);
    }

    function test_notYetValidIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n5"));
        a.validAfter = block.timestamp;
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        _submit(a, v, r, s);
    }

    function test_tamperedFieldsAreRejected() public {
        Auth memory a = _auth(33_000, keccak256("n6"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);

        Auth memory more = _auth(33_001, a.nonce); // a fresh struct: memory assignment would alias `a`
        vm.expectRevert("FiatTokenV2: invalid signature");
        _submit(more, v, r, s);

        Auth memory redirected = _auth(33_000, a.nonce);
        redirected.to = relayer;
        vm.expectRevert("FiatTokenV2: invalid signature");
        _submit(redirected, v, r, s);

        // The signature is still usable as signed.
        _submit(a, v, r, s);
    }

    function test_wrongSignerIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n7"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(0xB0B, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.expectRevert("FiatTokenV2: invalid signature");
        _submit(a, v, r, s);
    }

    function test_highSIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n8"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        // The malleable twin (n - s, flipped v) recovers the same signer; FiatToken rejects it.
        bytes32 s2 = bytes32(N - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        assertGt(uint256(s2), HALF_N);
        vm.expectRevert("FiatTokenV2: invalid signature");
        _submit(a, v2, r, s2);
    }

    function test_badSignatureLengthIsRejected() public {
        Auth memory a = _auth(33_000, keccak256("n9"));
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, new bytes(64));
    }

    function test_insufficientBalanceRevertsAndLeavesNonceUnused() public {
        Auth memory a = _auth(10_000_001, keccak256("n10"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        _submit(a, v, r, s);
        assertFalse(usdc.authorizationState(payer, a.nonce), "a reverted settlement must not burn the nonce");
    }

    function test_transferAuthorizationCannotBeUsedAsReceive() public {
        Auth memory a = _auth(33_000, keccak256("n11"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.prank(payTo);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
    }

    // ---- receiveWithAuthorization ----

    function test_receiveWithAuthorization_onlyPayee() public {
        Auth memory a = _auth(33_000, keccak256("r1"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
        vm.prank(payTo);
        usdc.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
        assertEq(usdc.balanceOf(payTo), 33_000);
    }

    // ---- cancelAuthorization ----

    function test_cancelAuthorizationBlocksLaterUse() public {
        Auth memory a = _auth(33_000, keccak256("c1"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        bytes32 cancelHash = keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, a.nonce));
        (uint8 cv, bytes32 cr, bytes32 cs) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), cancelHash)));
        vm.expectEmit(address(usdc));
        emit AuthorizationCanceled(payer, a.nonce);
        usdc.cancelAuthorization(payer, a.nonce, cv, cr, cs);
        assertTrue(usdc.authorizationState(payer, a.nonce));
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        _submit(a, v, r, s);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.cancelAuthorization(payer, a.nonce, cv, cr, cs);
    }

    function test_cancelRequiresAuthorizerSignature() public {
        bytes32 nonce = keccak256("c2");
        bytes32 cancelHash = keccak256(abi.encode(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), payer, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), cancelHash)));
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.cancelAuthorization(payer, nonce, v, r, s);
    }

    // ---- EIP-1271 smart wallets ----

    function test_eip1271WalletCanAuthorize() public {
        Wallet1271 w = new Wallet1271(payer);
        usdc.mint(address(w), 1_000_000);
        Auth memory a = Auth(address(w), payTo, 33_000, block.timestamp - 1, block.timestamp + 120, keccak256("w1"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        vm.prank(relayer);
        usdc.transferWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(payTo), 33_000);

        Auth memory b = Auth(address(w), payTo, 33_000, block.timestamp - 1, block.timestamp + 120, keccak256("w2"));
        (v, r, s) = _sign(0xB0B, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), b);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(b.from, b.to, b.value, b.validAfter, b.validBefore, b.nonce, abi.encodePacked(r, s, v));
    }

    // ---- ERC-20 basics ----

    function test_erc20TransferAndAllowance() public {
        vm.prank(payer);
        usdc.approve(relayer, 500);
        vm.prank(relayer);
        usdc.transferFrom(payer, payTo, 300);
        assertEq(usdc.allowance(payer, relayer), 200);
        vm.prank(relayer);
        vm.expectRevert("ERC20: transfer amount exceeds allowance");
        usdc.transferFrom(payer, payTo, 201);
        vm.prank(payer);
        vm.expectRevert("ERC20: transfer to the zero address");
        usdc.transfer(address(0), 1);
    }

    // ---- fuzz: conservation and single use ----

    function testFuzz_authorizationConservesSupplyAndIsSingleUse(uint256 value, bytes32 nonce) public {
        value = bound(value, 0, 10_000_000);
        Auth memory a = _auth(value, nonce);
        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), a);
        uint256 supply = usdc.totalSupply();
        _submit(a, v, r, s);
        assertEq(usdc.balanceOf(payer) + usdc.balanceOf(payTo), supply);
        assertEq(usdc.totalSupply(), supply);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        _submit(a, v, r, s);
    }
}
