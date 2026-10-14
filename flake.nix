{
  description = "AetherEdge — High-performance Cloudflare Workers VLESS & Trojan edge proxy in TypeScript";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    bun2nix,
  }:
    flake-utils.lib.eachDefaultSystem (system: let
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
        overlays = [
          bun2nix.overlays.default
        ];
      };
      bun2nixPkg = pkgs.bun2nix;
    in {
      devShells.default = pkgs.mkShell {
        packages = with pkgs; [
          bun
          bun2nixPkg
          wrangler
          xray
          curl
          jq
        ];
      };

      packages.default = pkgs.stdenv.mkDerivation {
        pname = "aether-edge";
        version = "1.1.0";
        src = ./.;

        nativeBuildInputs = with pkgs; [
          bun2nixPkg.hook
          bun
        ];

        bunDeps = bun2nixPkg.fetchBunDeps {
          bunNix = ./bun.nix;
        };

        buildPhase = ''
          runHook preBuild
          bun run build
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out/dist
          cp dist/worker.js $out/dist/worker.js
          sed 's#main = "src/index.tsx"#main = "dist/worker.js"#' wrangler.toml > $out/wrangler.toml
          runHook postInstall
        '';

        dontFixup = true;
      };
    });
}
