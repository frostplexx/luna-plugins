{
  description = "Dev environment for luna-plugins (Node.js + pnpm)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
        };

        nodejs = pkgs.nodejs_24; # newest Node.js LTS/Current in nixpkgs
        pnpm = pkgs.pnpm; # newest pnpm packaged in nixpkgs
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
          ];

          shellHook = ''
            echo "Node.js $(node --version) | pnpm $(pnpm --version)"
          '';

          # Let pnpm/node find binaries from .pnpm-store etc.
          NODE_OPTIONS = "--experimental-vm-modules";
          PUPPETEER_SKIP_DOWNLOAD = "1";
        };
      }
    );
}
