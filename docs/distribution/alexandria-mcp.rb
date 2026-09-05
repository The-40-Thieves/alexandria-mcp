# Homebrew formula for a tap (e.g. the-40-thieves/tap). Not submitted to
# homebrew-core: a 1-star, months-old npm wrapper does not clear core's
# traction bar (see the research notes in
# .superpowers/sdd/2026-09-03-alexandria-improvement-program/research/distribution-channels.md).
#
# Usage once the tap exists:
#   brew tap-new the-40-thieves/tap
#   cp docs/distribution/alexandria-mcp.rb "$(brew --repository)/Library/Taps/the-40-thieves/homebrew-tap/Formula/alexandria-mcp.rb"
#   brew install the-40-thieves/tap/alexandria-mcp
#
# Homebrew is not installed on this box (Cave, Ubuntu 24.04 ARM64), so this
# formula has not been run through `brew install` or `brew audit --new`
# here. Run `brew audit --new alexandria-mcp` on a Mac (or Linuxbrew host)
# before creating the tap repository.
class AlexandriaMcp < Formula
  desc "MCP server for querying, reading, and ingesting 152 public digital libraries"
  homepage "https://github.com/The-40-Thieves/alexandria-mcp"
  url "https://registry.npmjs.org/@the-40-thieves/alexandria-mcp/-/alexandria-mcp-11.0.0.tgz"
  sha256 "b1b31f8d11ff4d152805ed2171af50075125910755ed33433554b38ae4b09159"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    # There is no --help flag: the bin is stdio-only and starts the MCP
    # server on launch (verified against dist/index.js), so the test sends
    # a JSON-RPC initialize request over stdin and checks the response
    # names the server. The process exits on its own once stdin closes.
    require "open3"
    request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "brew-test", version: "1.0.0" },
      },
    }.to_json

    output, status = Open3.capture2(
      { "TRANSPORT" => "stdio" },
      bin/"alexandria-mcp",
      stdin_data: "#{request}\n",
    )
    assert_predicate status, :success?
    assert_match "alexandria", output
  end
end
