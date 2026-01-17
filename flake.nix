{
  description = "Dev shell for yet-another-opencode-cursor-auth (Bun/TypeScript)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{
      flake-parts,
      nixpkgs,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      perSystem =
        {
          pkgs,
          system,
          ...
        }:
        let
          isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
        in
        {
          devShells.default = pkgs.mkShell {
            # Keep common native build tooling around so "bun install" won't fail
            # when dependencies include native addons (even if currently they don't).
            packages =
              [
                pkgs.bun
                pkgs.nodejs_20
                pkgs.nodePackages.typescript
                pkgs.nodePackages.typescript-language-server

                pkgs.git
                pkgs.cacert

                pkgs.pkg-config
                pkgs.openssl
                pkgs.python3
                pkgs.gnumake
              ]
              ++ pkgs.lib.optionals isDarwin [
                # Useful for some native deps on macOS.
                pkgs.libiconv
              ];

            shellHook = ''
              echo "my-plugin dev shell (${system})"
              echo "  bun install"
              echo "  bun run build | test | test:integration | start"
            '';
          };
        };
    };
}

