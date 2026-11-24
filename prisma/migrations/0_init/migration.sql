-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Phase" AS ENUM ('LOBBY', 'GREETINGS', 'BUILD', 'SCORING', 'JUDGING', 'REVEAL', 'RESULTS');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('PENDING', 'VALIDATING', 'GENERATING', 'READY', 'FAILED', 'REJECTED', 'REMOVED', 'LEDGERED');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('OK', 'FALLBACK_OK', 'ERROR', 'TIMEOUT_BLOCKED');

-- CreateEnum
CREATE TYPE "RoundRole" AS ENUM ('PEOPLES_CHOICE', 'GM_WINNER', 'NONE');

-- CreateTable
CREATE TABLE "Game" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "phase" "Phase" NOT NULL DEFAULT 'LOBBY',
    "round" INTEGER NOT NULL DEFAULT 1,
    "theme" TEXT,
    "config" JSONB NOT NULL,
    "style" JSONB,
    "scoringOrder" JSONB,
    "phaseEndsAt" TIMESTAMP(3),
    "cutoffAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "joinToken" TEXT NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Greeting" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "styleHint" JSONB,

    CONSTRAINT "Greeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "promptRaw" TEXT NOT NULL,
    "subject" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "imageUrl" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "visualWeight" DOUBLE PRECISION,
    "contentBox" JSONB,
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedAt" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayoutState" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "greetingStyle" JSONB,
    "placements" JSONB NOT NULL,
    "critique" JSONB,
    "source" TEXT NOT NULL DEFAULT 'solver',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayoutState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "voterPlayerId" TEXT NOT NULL,
    "voterTeamId" TEXT NOT NULL,
    "targetTeamId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WinnerPick" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "teamId" TEXT NOT NULL,
    "role" "RoundRole" NOT NULL,

    CONSTRAINT "WinnerPick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MontageState" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "stagedInputs" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'STAGED',
    "promptText" TEXT,
    "imageUrl" TEXT,
    "imageSeq" INTEGER,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MontageState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCall" (
    "id" TEXT NOT NULL,
    "gameId" TEXT,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usage" JSONB,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Game_code_key" ON "Game"("code");

-- CreateIndex
CREATE INDEX "Game_phase_idx" ON "Game"("phase");

-- CreateIndex
CREATE UNIQUE INDEX "Team_joinToken_key" ON "Team"("joinToken");

-- CreateIndex
CREATE INDEX "Team_gameId_idx" ON "Team"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_gameId_label_key" ON "Team"("gameId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "Player_sessionToken_key" ON "Player"("sessionToken");

-- CreateIndex
CREATE INDEX "Player_sessionToken_idx" ON "Player"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "Player_gameId_nickname_key" ON "Player"("gameId", "nickname");

-- CreateIndex
CREATE UNIQUE INDEX "Greeting_teamId_round_key" ON "Greeting"("teamId", "round");

-- CreateIndex
CREATE INDEX "Item_teamId_status_idx" ON "Item"("teamId", "status");

-- CreateIndex
CREATE INDEX "Item_playerId_status_idx" ON "Item"("playerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Item_teamId_round_promptRaw_playerId_key" ON "Item"("teamId", "round", "promptRaw", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "LayoutState_teamId_round_key" ON "LayoutState"("teamId", "round");

-- CreateIndex
CREATE INDEX "Score_gameId_round_targetTeamId_idx" ON "Score"("gameId", "round", "targetTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "Score_round_voterPlayerId_targetTeamId_key" ON "Score"("round", "voterPlayerId", "targetTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "WinnerPick_gameId_round_role_key" ON "WinnerPick"("gameId", "round", "role");

-- CreateIndex
CREATE INDEX "MontageState_teamId_idx" ON "MontageState"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "MontageState_teamId_round_key" ON "MontageState"("teamId", "round");

-- CreateIndex
CREATE INDEX "AiCall_gameId_task_idx" ON "AiCall"("gameId", "task");

-- CreateIndex
CREATE INDEX "AiCall_createdAt_idx" ON "AiCall"("createdAt");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Greeting" ADD CONSTRAINT "Greeting_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LayoutState" ADD CONSTRAINT "LayoutState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_voterPlayerId_fkey" FOREIGN KEY ("voterPlayerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_voterTeamId_fkey" FOREIGN KEY ("voterTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_targetTeamId_fkey" FOREIGN KEY ("targetTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WinnerPick" ADD CONSTRAINT "WinnerPick_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WinnerPick" ADD CONSTRAINT "WinnerPick_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MontageState" ADD CONSTRAINT "MontageState_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCall" ADD CONSTRAINT "AiCall_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE SET NULL ON UPDATE CASCADE;

