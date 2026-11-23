# ============================================================
#  PayMaybe - Full Setup Script
#  Run from: PowerShell (outside this app) as normal user
#  Usage: cd C:\Users\HP\Downloads\paymaybe ; .\scripts\setup.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$PROJECT = "C:\Users\HP\Downloads\paymaybe"

function Step($n, $msg) {
    Write-Host ""
    Write-Host "[$n] $msg" -ForegroundColor Cyan
    Write-Host ("-------------------------------------------------------") -ForegroundColor DarkGray
}

function OK($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function WARN($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function ERR($msg)  { Write-Host "  [ERROR] $msg" -ForegroundColor Red }
function INFO($msg) { Write-Host "  -> $msg" -ForegroundColor Gray }

function Pause-ForInstall($name) {
    Write-Host ""
    WARN "$name was just installed. CLOSE THIS TERMINAL, open a fresh one,"
    WARN "then run this script again to continue."
    Write-Host "  Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

Write-Host ""
Write-Host "================================================" -ForegroundColor Magenta
Write-Host "   PayMaybe - Hackathon Setup Script" -ForegroundColor Magenta
Write-Host "   MagicBlock Solana Blitz v10, Nov 2026" -ForegroundColor Magenta
Write-Host "================================================" -ForegroundColor Magenta

# --- STEP 1: Git ---
Step 1 "Checking Git"
if (Get-Command git -ErrorAction SilentlyContinue) {
    OK "Git found: $(git --version)"
} else {
    INFO "Installing Git via winget..."
    winget install --id Git.Git -e --source winget
    Pause-ForInstall "Git"
}

# --- STEP 2: Rust ---
Step 2 "Checking Rust / Cargo"
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    OK "Cargo found: $(cargo --version)"
    INFO "Ensuring Rust 1.89 toolchain is available..."
    try {
        rustup toolchain install 1.89
        rustup default 1.89
    } catch {
        WARN "Could not switch to 1.89 specifically, using current toolchain."
    }
    OK "Rust toolchain: $(rustc --version)"
} else {
    INFO "Installing Rust via winget..."
    winget install --id Rustlang.Rustup -e
    Pause-ForInstall "Rust"
}

# --- STEP 3: Solana CLI ---
Step 3 "Checking Solana / Agave CLI"
$solanaBin = "$env:USERPROFILE\.local\share\solana\install\active_release\bin"
if (Test-Path $solanaBin) {
    $env:PATH = "$solanaBin;$env:PATH"
}
if (Get-Command solana -ErrorAction SilentlyContinue) {
    OK "Solana found: $(solana --version)"
} else {
    INFO "Downloading Agave/Solana CLI installer..."
    $tmpDir = "$env:TEMP\solana-install-tmp"
    if (!(Test-Path $tmpDir)) { New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null }
    $installer = "$tmpDir\agave-install-init.exe"
    
    $downloadSuccess = $false
    $urls = @(
        "https://release.anza.xyz/stable/agave-install-init-x86_64-pc-windows-msvc.exe",
        "https://release.solana.com/stable/solana-install-init-x86_64-pc-windows-msvc.exe"
    )
    foreach ($url in $urls) {
        try {
            INFO "Trying: $url"
            curl.exe -L -s -o $installer $url
            if (Test-Path $installer) {
                $downloadSuccess = $true
                break
            }
        } catch {}
    }

    if ($downloadSuccess) {
        INFO "Running installer (stable)..."
        & $installer stable
        $env:PATH = "$solanaBin;$env:PATH"
        if (Get-Command solana -ErrorAction SilentlyContinue) {
            OK "Solana installed: $(solana --version)"
        } else {
            WARN "Solana installed but terminal PATH needs a refresh."
            INFO "Location: $solanaBin"
            Pause-ForInstall "Solana"
        }
    } else {
        ERR "Failed to download Solana installer."
        exit 1
    }
}

# --- STEP 4: Anchor CLI ---
Step 4 "Checking Anchor CLI 1.0.2"
$anchorBinDir = "$env:USERPROFILE\.cargo\bin"
if (Test-Path $anchorBinDir) { $env:PATH = "$anchorBinDir;$env:PATH" }
if (Get-Command anchor -ErrorAction SilentlyContinue) {
    OK "Anchor found: $(anchor --version)"
} else {
    INFO "Downloading prebuilt Anchor 1.0.2 Windows binary (no compilation needed)..."
    if (!(Test-Path $anchorBinDir)) { New-Item -ItemType Directory -Path $anchorBinDir -Force | Out-Null }
    $anchorExe = "$anchorBinDir\anchor.exe"
    curl.exe -L -sSf -o $anchorExe "https://github.com/solana-foundation/anchor/releases/download/v1.0.2/anchor-1.0.2-x86_64-pc-windows-msvc.exe"
    if (Get-Command anchor -ErrorAction SilentlyContinue) {
        OK "Anchor installed: $(anchor --version)"
    } else {
        ERR "Anchor download failed."
        exit 1
    }
}

# --- STEP 5: Solana Keypair ---
Step 5 "Setting up Solana Devnet keypair"
$configDir = "$env:USERPROFILE\.config\solana"
if (!(Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$keypairPath = "$configDir\id.json"
if (Test-Path $keypairPath) {
    OK "Keypair already exists at $keypairPath"
} else {
    INFO "Generating new keypair..."
    solana-keygen new --no-bip39-passphrase -o $keypairPath
    OK "Keypair created"
}

INFO "Setting cluster to devnet..."
solana config set --url devnet
$pubkey = solana-keygen pubkey $keypairPath
OK "Wallet: $pubkey"

INFO "Requesting airdrop (2 SOL)..."
try {
    solana airdrop 2 $pubkey
    OK "Airdrop requested successfully"
} catch {
    WARN "Airdrop request had an issue (faucet rate-limits are common on devnet)."
    WARN "If balance is 0, get Devnet SOL at https://faucet.solana.com"
}

# --- STEP 6: npm install (client + frontend) ---
Step 6 "Installing Node.js dependencies"
INFO "Installing client dependencies..."
Set-Location "$PROJECT\client"
npm install
OK "Client dependencies installed"

INFO "Installing frontend dependencies..."
Set-Location "$PROJECT\frontend"
npm install
OK "Frontend dependencies installed"

Set-Location $PROJECT

# --- STEP 7: Build Anchor program ---
Step 7 "Building Anchor program"
INFO "Running anchor build..."
anchor build
OK "Program built successfully"

# --- STEP 8: Deploy to Devnet ---
Step 8 "Deploying program to Devnet"
INFO "Deploying..."
$deployOut = anchor deploy 2>&1
$deployOut | ForEach-Object { Write-Host $_ }
$match = ($deployOut | Select-String "Program Id:\s*([A-Za-z0-9]+)")
if ($match) {
    $programId = $match.Matches[0].Groups[1].Value
    OK "Deployed! Program ID: $programId"

    # --- STEP 9: Update program ID ---
    Step 9 "Updating Program ID in all files"
    node "$PROJECT\scripts\update-program-id.mjs" $programId
    OK "Program ID propagated"

    INFO "Rebuilding Anchor program with correct ID..."
    anchor build
    OK "Rebuild complete"
} else {
    WARN "Could not automatically parse Program Id from deploy output."
    WARN "If it deployed, find the Program ID above and run:"
    WARN "  node scripts\update-program-id.mjs <PROGRAM_ID>"
}

# --- STEP 10: Milestone 0 Probe ---
Step 10 "Running Milestone 0 Devnet Probe"
Set-Location "$PROJECT\client"
if ($programId) {
    $env:PROGRAM_ID = $programId
}
npm run probe
Set-Location $PROJECT

# --- STEP 11: Launch Frontend ---
Step 11 "Launching Frontend"
Write-Host ""
OK "Setup complete! Starting Next.js dev server..."
INFO "Open http://localhost:3000 in your browser"
INFO "Connect Phantom (switch network to Devnet)"
INFO "Press Ctrl+C to stop"
Write-Host ""
Set-Location "$PROJECT\frontend"
npm run dev
