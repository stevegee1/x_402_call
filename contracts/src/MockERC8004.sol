// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * TEST ONLY. Minimal ERC-8004 Identity and Reputation registries for a local anvil node, installed
 * with anvil_setCode at the canonical Base Sepolia addresses. They reproduce the behaviour the gateway
 * depends on, as in the reference implementation (github.com/erc-8004/erc-8004-contracts):
 *  - register() mints an agent NFT and sets agentWallet to msg.sender;
 *  - a transfer between owners clears agentWallet;
 *  - giveFeedback forbids self-feedback, caps decimals at 18, and stores value/decimals/tags;
 *  - getSummary requires a client filter, treats empty tags as wildcards, skips revoked entries and
 *    returns the mean normalised to 18 decimals, scaled to the most frequent decimals (ties: lowest).
 * No constructor and no initialised storage, so they work when installed with setCode.
 * setAgentWallet (EIP-712 wallet proofs) and validation are out of scope.
 */
contract MockIdentityRegistry {
    string public constant name = "AgentIdentity";
    string public constant symbol = "AGENT";

    uint256 private _nextId;
    mapping(uint256 => address) private _owners;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => string) private _uris;
    mapping(uint256 => address) private _wallets;
    mapping(uint256 => address) public getApproved;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function register() external returns (uint256) {
        return _register("");
    }

    function register(string calldata agentURI) external returns (uint256) {
        return _register(agentURI);
    }

    function _register(string memory agentURI) private returns (uint256 agentId) {
        agentId = _nextId++;
        _owners[agentId] = msg.sender;
        balanceOf[msg.sender]++;
        _uris[agentId] = agentURI;
        _wallets[agentId] = msg.sender;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function ownerOf(uint256 agentId) public view returns (address o) {
        o = _owners[agentId];
        require(o != address(0), "ERC721NonexistentToken");
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        ownerOf(agentId);
        return _uris[agentId];
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return _wallets[agentId];
    }

    function unsetAgentWallet(uint256 agentId) external {
        require(isAuthorizedOrOwner(msg.sender, agentId), "not authorized");
        _wallets[agentId] = address(0);
    }

    function approve(address to, uint256 agentId) external {
        require(msg.sender == ownerOf(agentId), "not owner");
        getApproved[agentId] = to;
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) public view returns (bool) {
        address o = ownerOf(agentId);
        return spender == o || getApproved[agentId] == spender;
    }

    function transferFrom(address from, address to, uint256 agentId) external {
        require(isAuthorizedOrOwner(msg.sender, agentId) && ownerOf(agentId) == from, "not authorized");
        require(to != address(0), "zero address");
        _owners[agentId] = to;
        balanceOf[from]--;
        balanceOf[to]++;
        delete getApproved[agentId];
        _wallets[agentId] = address(0); // the verified wallet never carries over to a new owner
        emit Transfer(from, to, agentId);
    }
}

interface IIdentity {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

contract MockReputationRegistry {
    /// The canonical Base Sepolia identity registry, where the harness installs MockIdentityRegistry.
    address public constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    int128 private constant MAX_ABS_VALUE = 1e38;

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool isRevoked;
    }

    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private _feedback;
    mapping(uint256 => mapping(address => uint64)) private _lastIndex;
    mapping(uint256 => address[]) private _clients;
    mapping(uint256 => mapping(address => bool)) private _isClient;

    /// Reduced from the reference event (no endpoint / URI / hash fields): nothing here reads events.
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);

    function getIdentityRegistry() external pure returns (address) {
        return IDENTITY;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string memory tag1,
        string memory tag2,
        string memory endpoint,
        string memory feedbackURI,
        bytes32 feedbackHash
    ) external {
        // `memory` strings (one stack slot each, same ABI as calldata) keep this under the stack limit.
        require(valueDecimals <= 18, "too many decimals");
        require(value >= -MAX_ABS_VALUE && value <= MAX_ABS_VALUE, "value too large");
        require(!IIdentity(IDENTITY).isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        uint64 idx = ++_lastIndex[agentId][msg.sender];
        _feedback[agentId][msg.sender][idx] = Feedback(value, valueDecimals, tag1, tag2, false);
        if (!_isClient[agentId][msg.sender]) {
            _isClient[agentId][msg.sender] = true;
            _clients[agentId].push(msg.sender);
        }
        emit NewFeedback(agentId, msg.sender, idx, value, valueDecimals, tag1, tag2);
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        require(feedbackIndex > 0 && feedbackIndex <= _lastIndex[agentId][msg.sender], "index out of bounds");
        Feedback storage f = _feedback[agentId][msg.sender][feedbackIndex];
        require(!f.isRevoked, "Already revoked");
        f.isRevoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128, uint8, string memory, string memory, bool)
    {
        Feedback storage f = _feedback[agentId][clientAddress][feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return _lastIndex[agentId][clientAddress];
    }

    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    struct Filter {
        bytes32 empty;
        bytes32 tag1;
        bytes32 tag2;
    }

    function getSummary(uint256 agentId, address[] memory clientAddresses, string memory tag1, string memory tag2)
        external
        view
        returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
    {
        require(clientAddresses.length > 0, "clientAddresses required");
        Filter memory f = Filter(keccak256(bytes("")), keccak256(bytes(tag1)), keccak256(bytes(tag2)));
        int256 sum;
        uint64[19] memory decimalsSeen;
        for (uint256 i = 0; i < clientAddresses.length; i++) {
            (int256 s, uint64 c) = _accumulate(agentId, clientAddresses[i], f, decimalsSeen);
            sum += s;
            count += c;
        }
        if (count == 0) return (0, 0, 0);
        uint8 mode;
        for (uint8 d = 1; d <= 18; d++) {
            if (decimalsSeen[d] > decimalsSeen[mode]) mode = d;
        }
        summaryValue = int128((sum / int256(uint256(count))) / int256(10 ** (18 - mode)));
        summaryValueDecimals = mode;
    }

    /// Sums one client's matching feedback, normalised to 18 decimals; tallies decimals in place.
    function _accumulate(uint256 agentId, address client, Filter memory f, uint64[19] memory decimalsSeen)
        private
        view
        returns (int256 sum, uint64 count)
    {
        uint64 last = _lastIndex[agentId][client];
        for (uint64 j = 1; j <= last; j++) {
            Feedback storage fb = _feedback[agentId][client][j];
            if (fb.isRevoked) continue;
            if (f.tag1 != f.empty && keccak256(bytes(fb.tag1)) != f.tag1) continue;
            if (f.tag2 != f.empty && keccak256(bytes(fb.tag2)) != f.tag2) continue;
            sum += int256(fb.value) * int256(10 ** (18 - fb.valueDecimals));
            decimalsSeen[fb.valueDecimals]++;
            count++;
        }
    }
}
