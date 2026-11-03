// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockIdentityRegistry, MockReputationRegistry} from "../src/MockERC8004.sol";

contract MockERC8004Test is Test {
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;

    MockIdentityRegistry id;
    MockReputationRegistry rep;
    address agent = makeAddr("agent");
    address reviewer = makeAddr("reviewer");
    address other = makeAddr("other");

    function setUp() public {
        vm.etch(IDENTITY, type(MockIdentityRegistry).runtimeCode);
        vm.etch(REPUTATION, type(MockReputationRegistry).runtimeCode);
        id = MockIdentityRegistry(IDENTITY);
        rep = MockReputationRegistry(REPUTATION);
    }

    function _register(address who) internal returns (uint256 agentId) {
        vm.prank(who);
        agentId = id.register("ipfs://agent.json");
    }

    function _feedback(address from, uint256 agentId, int128 value, uint8 decimals, string memory tag) internal {
        vm.prank(from);
        rep.giveFeedback(agentId, value, decimals, tag, "", "", "", bytes32(0));
    }

    function _clients() internal view returns (address[] memory c) {
        c = new address[](1);
        c[0] = reviewer;
    }

    // ---- interface fidelity: the selectors the gateway calls on the real registries ----

    function test_selectorsMatchErc8004() public pure {
        assertEq(MockIdentityRegistry.getAgentWallet.selector, bytes4(keccak256("getAgentWallet(uint256)")));
        assertEq(MockReputationRegistry.getSummary.selector, bytes4(keccak256("getSummary(uint256,address[],string,string)")));
        assertEq(
            MockReputationRegistry.giveFeedback.selector,
            bytes4(keccak256("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"))
        );
    }

    function test_nameMatchesLiveRegistry() public view {
        assertEq(id.name(), "AgentIdentity");
        assertEq(rep.getIdentityRegistry(), IDENTITY);
    }

    // ---- identity ----

    function test_registerBindsWalletToRegistrant() public {
        uint256 a = _register(agent);
        uint256 b = _register(other);
        assertEq(b, a + 1);
        assertEq(id.ownerOf(a), agent);
        assertEq(id.getAgentWallet(a), agent);
        assertEq(id.tokenURI(a), "ipfs://agent.json");
    }

    function test_transferClearsWallet() public {
        uint256 a = _register(agent);
        vm.prank(agent);
        id.transferFrom(agent, other, a);
        assertEq(id.ownerOf(a), other);
        assertEq(id.getAgentWallet(a), address(0));
    }

    function test_onlyOwnerCanTransferOrUnset() public {
        uint256 a = _register(agent);
        vm.prank(other);
        vm.expectRevert("not authorized");
        id.transferFrom(agent, other, a);
        vm.prank(other);
        vm.expectRevert("not authorized");
        id.unsetAgentWallet(a);
        vm.prank(agent);
        id.unsetAgentWallet(a);
        assertEq(id.getAgentWallet(a), address(0));
    }

    function test_unknownAgentHasNoWallet() public view {
        assertEq(id.getAgentWallet(999), address(0));
    }

    // ---- reputation ----

    function test_summaryIsMeanOfNonRevoked() public {
        uint256 a = _register(agent);
        _feedback(reviewer, a, 85, 0, "quality");
        _feedback(reviewer, a, -20, 0, "reliability");
        _feedback(reviewer, a, 85, 0, "quality");
        vm.prank(reviewer);
        rep.revokeFeedback(a, 2);
        (uint64 count, int128 value, uint8 decimals) = rep.getSummary(a, _clients(), "", "");
        // Matches what the live Base Sepolia registry returns for the same pattern.
        assertEq(count, 2);
        assertEq(value, 85);
        assertEq(decimals, 0);
    }

    function test_tagFilterAndWildcard() public {
        uint256 a = _register(agent);
        _feedback(reviewer, a, 90, 0, "quality");
        _feedback(reviewer, a, 10, 0, "speed");
        (uint64 c1, int128 v1,) = rep.getSummary(a, _clients(), "quality", "");
        assertEq(c1, 1);
        assertEq(v1, 90);
        (uint64 c2, int128 v2,) = rep.getSummary(a, _clients(), "", "");
        assertEq(c2, 2);
        assertEq(v2, 50);
    }

    function test_mixedDecimalsUseTheMostFrequentPrecision() public {
        uint256 a = _register(agent);
        _feedback(reviewer, a, 9977, 2, "uptime"); // 99.77
        _feedback(reviewer, a, 9900, 2, "uptime"); // 99.00
        _feedback(reviewer, a, 98, 0, "uptime"); // 98
        (uint64 count, int128 value, uint8 decimals) = rep.getSummary(a, _clients(), "", "");
        assertEq(count, 3);
        assertEq(decimals, 2);
        assertEq(value, 9892); // mean 98.9233.. -> 98.92
    }

    function test_onlyListedClientsCount() public {
        uint256 a = _register(agent);
        _feedback(other, a, -100, 0, "");
        (uint64 count,,) = rep.getSummary(a, _clients(), "", "");
        assertEq(count, 0);
    }

    function test_summaryRequiresClients() public {
        uint256 a = _register(agent);
        vm.expectRevert("clientAddresses required");
        rep.getSummary(a, new address[](0), "", "");
    }

    function test_selfFeedbackForbidden() public {
        uint256 a = _register(agent);
        vm.prank(agent);
        vm.expectRevert("Self-feedback not allowed");
        rep.giveFeedback(a, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_feedbackForUnknownAgentReverts() public {
        vm.prank(reviewer);
        vm.expectRevert("ERC721NonexistentToken");
        rep.giveFeedback(12345, 100, 0, "", "", "", "", bytes32(0));
    }

    function test_feedbackBounds() public {
        uint256 a = _register(agent);
        vm.startPrank(reviewer);
        vm.expectRevert("too many decimals");
        rep.giveFeedback(a, 1, 19, "", "", "", "", bytes32(0));
        vm.expectRevert("value too large");
        rep.giveFeedback(a, 1e38 + 1, 0, "", "", "", "", bytes32(0));
        vm.stopPrank();
    }

    function test_revokeOnlyOnceAndInBounds() public {
        uint256 a = _register(agent);
        _feedback(reviewer, a, 1, 0, "");
        vm.startPrank(reviewer);
        rep.revokeFeedback(a, 1);
        vm.expectRevert("Already revoked");
        rep.revokeFeedback(a, 1);
        vm.expectRevert("index out of bounds");
        rep.revokeFeedback(a, 2);
        vm.stopPrank();
        assertEq(rep.getLastIndex(a, reviewer), 1);
        assertEq(rep.getClients(a).length, 1);
    }
}
