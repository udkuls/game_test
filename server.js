// server.js - WebSocket сервер для ретрансляции с игровой логикой
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'game.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocket.Server({ server });

// Хранилище комнат
const rooms = new Map();

// Конфигурация игры
const GAME_CONFIG = {
    ENEMY_BASE_HP: 10,
    ENEMY_DAMAGE: 10,
    ENEMY_RADIUS: 16,
    ENEMY_SPEED: 140,
    PROJECTILE_SPEED: 400,
    PROJECTILE_RADIUS: 8,
    EXP_PER_KILL: 10,
    SPAWN_DELAY: 0.8,
    PLAYER_SPEED: 320,
    INVINCIBLE_TIME: 0.6,
    ATTACK_COOLDOWN_BASE: 3.0,
    START_PLAYER_DAMAGE: 5,
    LEVEL_UP_DAMAGE_BONUS: 2,
    LEVEL_UP_COOLDOWN_REDUCTION: 0.4,
    MIN_ATTACK_COOLDOWN: 0.9,
    SHOOTER_ENEMY_RATIO: 0.3,
    ENEMY_SHOOT_COOLDOWN: 2.0,
    ENEMY_PROJECTILE_SPEED: 250,
    ENEMY_PROJECTILE_DAMAGE: 8
};

// Класс для управления комнатой
class GameRoom {
    constructor(roomId, hostWs, hostName) {
        this.roomId = roomId;
        this.host = hostWs;
        this.guest = null;
        this.gameStarted = false;
        this.enemies = [];
        this.projectiles = [];
        this.enemySpawnTimer = 0;
        this.sharedExp = 0;
        this.sharedLevel = 1;
        this.sharedExpNeeded = 100;
        
        this.players = {
            host: {
                ws: hostWs,
                id: Math.random().toString(36).substring(2, 10),
                name: hostName,
                x: 300,
                y: 300,
                radius: 18,
                hp: 100,
                maxHp: 100,
                damage: GAME_CONFIG.START_PLAYER_DAMAGE,
                level: 1,
                attackCooldown: GAME_CONFIG.ATTACK_COOLDOWN_BASE,
                attackTimer: 0,
                invincibleTimer: 0,
                color: '#4a9eff',
                colorDark: '#2a6ecc'
            },
            guest: null
        };
        
        this.enemySpawnTimer = GAME_CONFIG.SPAWN_DELAY;
    }
    
    addGuest(ws, name) {
        if (this.guest) return false;
        this.guest = ws;
        this.players.guest = {
            ws: ws,
            id: Math.random().toString(36).substring(2, 10),
            name: name,
            x: 500,
            y: 300,
            radius: 18,
            hp: 100,
            maxHp: 100,
            damage: GAME_CONFIG.START_PLAYER_DAMAGE,
            level: 1,
            attackCooldown: GAME_CONFIG.ATTACK_COOLDOWN_BASE,
            attackTimer: 0,
            invincibleTimer: 0,
            color: '#ff6a6a',
            colorDark: '#cc4a4a'
        };
        return true;
    }
    
    removePlayer(ws) {
        if (this.host === ws) {
            if (this.guest) {
                this.sendToGuest({ type: 'hostDisconnected', message: 'Хост отключился' });
            }
            return true;
        } else if (this.guest === ws) {
            this.guest = null;
            this.players.guest = null;
            this.sendToHost({ type: 'guestDisconnected', message: 'Игрок отключился' });
            return true;
        }
        return false;
    }
    
    sendToHost(data) {
        if (this.host && this.host.readyState === WebSocket.OPEN) {
            this.host.send(JSON.stringify(data));
        }
    }
    
    sendToGuest(data) {
        if (this.guest && this.guest.readyState === WebSocket.OPEN) {
            this.guest.send(JSON.stringify(data));
        }
    }
    
    broadcast(data) {
        this.sendToHost(data);
        this.sendToGuest(data);
    }
    
    updateSharedExp(amount) {
        this.sharedExp += amount;
        let leveledUp = false;
        while (this.sharedExp >= this.sharedExpNeeded) {
            this.sharedExp -= this.sharedExpNeeded;
            this.sharedLevel++;
            this.sharedExpNeeded = this.sharedLevel * 100;
            leveledUp = true;
        }
        
        if (leveledUp) {
            const damageBonus = GAME_CONFIG.LEVEL_UP_DAMAGE_BONUS;
            const cooldownReduction = GAME_CONFIG.LEVEL_UP_COOLDOWN_REDUCTION;
            
            this.players.host.damage += damageBonus;
            let newCooldown = this.players.host.attackCooldown - cooldownReduction;
            if (newCooldown < GAME_CONFIG.MIN_ATTACK_COOLDOWN) newCooldown = GAME_CONFIG.MIN_ATTACK_COOLDOWN;
            this.players.host.attackCooldown = newCooldown;
            
            if (this.players.guest) {
                this.players.guest.damage += damageBonus;
                let newCooldownGuest = this.players.guest.attackCooldown - cooldownReduction;
                if (newCooldownGuest < GAME_CONFIG.MIN_ATTACK_COOLDOWN) newCooldownGuest = GAME_CONFIG.MIN_ATTACK_COOLDOWN;
                this.players.guest.attackCooldown = newCooldownGuest;
            }
            
            this.broadcast({
                type: 'levelUp',
                level: this.sharedLevel,
                hostDamage: this.players.host.damage,
                guestDamage: this.players.guest ? this.players.guest.damage : 0,
                hostCooldown: this.players.host.attackCooldown,
                guestCooldown: this.players.guest ? this.players.guest.attackCooldown : 0
            });
        }
        
        this.broadcast({
            type: 'expUpdate',
            exp: this.sharedExp,
            expNeeded: this.sharedExpNeeded,
            level: this.sharedLevel
        });
    }
    
    spawnEnemy() {
        const side = Math.floor(Math.random() * 4);
        let x, y;
        const padding = 50;
        
        if (side === 0) { x = Math.random() * 800; y = -padding; }
        else if (side === 2) { x = Math.random() * 800; y = 600 + padding; }
        else if (side === 1) { x = 800 + padding; y = Math.random() * 600; }
        else { x = -padding; y = Math.random() * 600; }
        
        const isShooter = Math.random() < GAME_CONFIG.SHOOTER_ENEMY_RATIO;
        
        const enemy = {
            id: Math.random().toString(36).substring(2, 10) + Date.now(),
            x: x,
            y: y,
            hp: GAME_CONFIG.ENEMY_BASE_HP,
            maxHp: GAME_CONFIG.ENEMY_BASE_HP,
            radius: GAME_CONFIG.ENEMY_RADIUS,
            isShooter: isShooter,
            shootTimer: isShooter ? Math.random() * GAME_CONFIG.ENEMY_SHOOT_COOLDOWN : 0
        };
        
        this.enemies.push(enemy);
        this.broadcast({ type: 'spawnEnemy', enemy: enemy });
    }
    
    updateGame(deltaTime) {
        if (!this.gameStarted) return;
        
        // Спавн врагов
        this.enemySpawnTimer -= deltaTime;
        while (this.enemySpawnTimer <= 0) {
            this.spawnEnemy();
            this.enemySpawnTimer += GAME_CONFIG.SPAWN_DELAY;
        }
        
        // Обновление атак игроков
        [this.players.host, this.players.guest].forEach(player => {
            if (player && player.hp > 0) {
                if (player.attackTimer <= 0) {
                    if (this.enemies.length > 0) {
                        const aliveEnemies = this.enemies.filter(e => e.hp > 0);
                        if (aliveEnemies.length > 0) {
                            const target = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
                            const dx = target.x - player.x;
                            const dy = target.y - player.y;
                            const len = Math.hypot(dx, dy);
                            if (len > 0.01) {
                                const projectile = {
                                    id: Math.random().toString(36).substring(2, 10),
                                    x: player.x,
                                    y: player.y,
                                    vx: (dx / len) * GAME_CONFIG.PROJECTILE_SPEED,
                                    vy: (dy / len) * GAME_CONFIG.PROJECTILE_SPEED,
                                    radius: GAME_CONFIG.PROJECTILE_RADIUS,
                                    damage: player.damage,
                                    owner: player.id,
                                    isEnemy: false
                                };
                                this.projectiles.push(projectile);
                                this.broadcast({ type: 'spawnProjectile', projectile: projectile });
                            }
                        }
                    }
                    player.attackTimer = player.attackCooldown;
                } else {
                    player.attackTimer -= deltaTime;
                }
            }
        });
        
        // Обновление атак стреляющих мобов
        for (const enemy of this.enemies) {
            if (enemy.hp <= 0) continue;
            if (enemy.isShooter) {
                enemy.shootTimer -= deltaTime;
                if (enemy.shootTimer <= 0) {
                    let closestPlayer = null;
                    let minDist = Infinity;
                    
                    if (this.players.host.hp > 0) {
                        const dist = Math.hypot(this.players.host.x - enemy.x, this.players.host.y - enemy.y);
                        if (dist < minDist) {
                            minDist = dist;
                            closestPlayer = this.players.host;
                        }
                    }
                    if (this.players.guest && this.players.guest.hp > 0) {
                        const dist = Math.hypot(this.players.guest.x - enemy.x, this.players.guest.y - enemy.y);
                        if (dist < minDist) {
                            minDist = dist;
                            closestPlayer = this.players.guest;
                        }
                    }
                    
                    if (closestPlayer && minDist < 400) {
                        const dx = closestPlayer.x - enemy.x;
                        const dy = closestPlayer.y - enemy.y;
                        const len = Math.hypot(dx, dy);
                        if (len > 0.01) {
                            const projectile = {
                                id: Math.random().toString(36).substring(2, 10),
                                x: enemy.x,
                                y: enemy.y,
                                vx: (dx / len) * GAME_CONFIG.ENEMY_PROJECTILE_SPEED,
                                vy: (dy / len) * GAME_CONFIG.ENEMY_PROJECTILE_SPEED,
                                radius: GAME_CONFIG.PROJECTILE_RADIUS - 2,
                                damage: GAME_CONFIG.ENEMY_PROJECTILE_DAMAGE,
                                owner: enemy.id,
                                isEnemy: true
                            };
                            this.projectiles.push(projectile);
                            this.broadcast({ type: 'spawnProjectile', projectile: projectile });
                        }
                    }
                    enemy.shootTimer = GAME_CONFIG.ENEMY_SHOOT_COOLDOWN;
                }
            }
        }
        
        // Обновление снарядов
        for (let i = 0; i < this.projectiles.length; i++) {
            const p = this.projectiles[i];
            p.x += p.vx * deltaTime;
            p.y += p.vy * deltaTime;
            
            if (p.x + p.radius < 0 || p.x - p.radius > 800 || p.y + p.radius < 0 || p.y - p.radius > 600) {
                this.projectiles.splice(i, 1);
                i--;
                continue;
            }
            
            let hit = false;
            
            if (p.isEnemy) {
                // Враждебный снаряд - проверяем попадание в игроков
                [this.players.host, this.players.guest].forEach(player => {
                    if (player && player.hp > 0 && !hit) {
                        // Уменьшаем таймер неуязвимости
                        if (player.invincibleTimer > 0) {
                            player.invincibleTimer -= deltaTime;
                        }
                        
                        if (Math.hypot(p.x - player.x, p.y - player.y) < p.radius + player.radius) {
                            if (player.invincibleTimer <= 0) {
                                player.hp = Math.max(0, player.hp - p.damage);
                                player.invincibleTimer = GAME_CONFIG.INVINCIBLE_TIME;
                                
                                console.log(`💔 ${player.name} получил урон от снаряда! HP: ${player.hp}`);
                                
                                this.broadcast({
                                    type: 'playerHurt',
                                    playerId: player.id,
                                    hp: player.hp,
                                    invincibleTimer: player.invincibleTimer
                                });
                                
                                if (player.hp <= 0) {
                                    this.broadcast({
                                        type: 'playerDead',
                                        playerId: player.id,
                                        playerName: player.name
                                    });
                                }
                            }
                            hit = true;
                        }
                    }
                });
            } else {
                // Дружественный снаряд - проверяем попадание во врагов
                for (let j = 0; j < this.enemies.length; j++) {
                    const e = this.enemies[j];
                    if (e.hp <= 0) continue;
                    if (Math.hypot(p.x - e.x, p.y - e.y) < p.radius + e.radius) {
                        e.hp -= p.damage;
                        hit = true;
                        if (e.hp <= 0) {
                            this.updateSharedExp(GAME_CONFIG.EXP_PER_KILL);
                            this.enemies.splice(j, 1);
                            j--;
                        }
                        break;
                    }
                }
            }
            
            if (hit) {
                this.projectiles.splice(i, 1);
                i--;
            }
        }
        
        // Обновление врагов (движение к игрокам)
        for (const enemy of this.enemies) {
            if (enemy.hp <= 0) continue;
            
            let closestPlayer = null;
            let minDist = Infinity;
            
            if (this.players.host.hp > 0) {
                const dist = Math.hypot(this.players.host.x - enemy.x, this.players.host.y - enemy.y);
                if (dist < minDist) {
                    minDist = dist;
                    closestPlayer = this.players.host;
                }
            }
            if (this.players.guest && this.players.guest.hp > 0) {
                const dist = Math.hypot(this.players.guest.x - enemy.x, this.players.guest.y - enemy.y);
                if (dist < minDist) {
                    minDist = dist;
                    closestPlayer = this.players.guest;
                }
            }
            
            if (closestPlayer) {
                const dx = closestPlayer.x - enemy.x;
                const dy = closestPlayer.y - enemy.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 0.01) {
                    const move = GAME_CONFIG.ENEMY_SPEED * deltaTime;
                    enemy.x += (dx / dist) * move;
                    enemy.y += (dy / dist) * move;
                }
                
                // Уменьшаем таймер неуязвимости
                if (closestPlayer.invincibleTimer > 0) {
                    closestPlayer.invincibleTimer -= deltaTime;
                }
                
                const distToPlayer = Math.hypot(closestPlayer.x - enemy.x, closestPlayer.y - enemy.y);
                if (distToPlayer < closestPlayer.radius + enemy.radius) {
                    if (closestPlayer.invincibleTimer <= 0 && closestPlayer.hp > 0) {
                        closestPlayer.hp = Math.max(0, closestPlayer.hp - GAME_CONFIG.ENEMY_DAMAGE);
                        closestPlayer.invincibleTimer = GAME_CONFIG.INVINCIBLE_TIME;
                        
                        console.log(`💔 ${closestPlayer.name} получил урон от моба! HP: ${closestPlayer.hp}`);
                        
                        this.broadcast({
                            type: 'playerHurt',
                            playerId: closestPlayer.id,
                            hp: closestPlayer.hp,
                            invincibleTimer: closestPlayer.invincibleTimer
                        });
                        
                        if (closestPlayer.hp <= 0) {
                            this.broadcast({
                                type: 'playerDead',
                                playerId: closestPlayer.id,
                                playerName: closestPlayer.name
                            });
                        }
                    }
                    
                    const angle = Math.atan2(enemy.y - closestPlayer.y, enemy.x - closestPlayer.x);
                    enemy.x += Math.cos(angle) * 25;
                    enemy.y += Math.sin(angle) * 25;
                    
                    const newDist = Math.hypot(closestPlayer.x - enemy.x, closestPlayer.y - enemy.y);
                    if (newDist < closestPlayer.radius + enemy.radius) {
                        enemy.x = closestPlayer.x + Math.cos(angle) * (closestPlayer.radius + enemy.radius + 5);
                        enemy.y = closestPlayer.y + Math.sin(angle) * (closestPlayer.radius + enemy.radius + 5);
                    }
                }
            }
        }
        
        // Проверка конца игры
        const bothDead = (this.players.host.hp <= 0 && (!this.players.guest || this.players.guest.hp <= 0));
        if (bothDead && this.gameStarted) {
            this.broadcast({ type: 'gameOver' });
            this.gameStarted = false;
            console.log(`🏁 Игра окончена в комнате ${this.roomId}`);
        }
        
        // Отправляем состояние игры
        this.broadcast({
            type: 'gameState',
            enemies: this.enemies,
            projectiles: this.projectiles,
            host: {
                hp: this.players.host.hp,
                x: this.players.host.x,
                y: this.players.host.y,
                damage: this.players.host.damage,
                attackCooldown: this.players.host.attackCooldown
            },
            guest: this.players.guest ? {
                hp: this.players.guest.hp,
                x: this.players.guest.x,
                y: this.players.guest.y,
                damage: this.players.guest.damage,
                attackCooldown: this.players.guest.attackCooldown
            } : null
        });
    }
}

wss.on('connection', (ws) => {
    let currentRoom = null;
    let playerId = null;
    let gameLoopInterval = null;
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'createRoom':
                    const roomId = Math.random().toString(36).substring(2, 10);
                    const room = new GameRoom(roomId, ws, data.name);
                    rooms.set(roomId, room);
                    currentRoom = room;
                    playerId = room.players.host.id;
                    
                    ws.send(JSON.stringify({
                        type: 'roomCreated',
                        roomId: roomId,
                        playerId: playerId,
                        playerNumber: 1
                    }));
                    console.log(`✅ Комната создана: ${roomId}`);
                    break;
                    
                case 'joinRoom':
                    const targetRoom = rooms.get(data.roomId);
                    if (targetRoom && targetRoom.addGuest(ws, data.name)) {
                        currentRoom = targetRoom;
                        playerId = targetRoom.players.guest.id;
                        
                        targetRoom.sendToHost({
                            type: 'playerJoined',
                            playerName: data.name,
                            playerId: playerId
                        });
                        
                        ws.send(JSON.stringify({
                            type: 'joined',
                            roomId: data.roomId,
                            playerId: playerId,
                            playerNumber: 2,
                            hostName: targetRoom.players.host.name
                        }));
                        
                        console.log(`👤 ${data.name} присоединился к ${data.roomId}`);
                    } else {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Комната не найдена или заполнена'
                        }));
                    }
                    break;
                    
                case 'startGame':
                    if (currentRoom && currentRoom.host === ws && !currentRoom.gameStarted) {
                        currentRoom.gameStarted = true;
                        currentRoom.broadcast({ type: 'gameStarted' });
                        console.log(`🎮 Игра началась в комнате ${currentRoom.roomId}`);
                        
                        let lastTime = Date.now();
                        gameLoopInterval = setInterval(() => {
                            const now = Date.now();
                            const delta = Math.min(0.033, (now - lastTime) / 1000);
                            lastTime = now;
                            currentRoom.updateGame(delta);
                        }, 1000 / 60);
                    }
                    break;
                    
                case 'playerMove':
                    if (currentRoom) {
                        const player = currentRoom.players.host.id === data.playerId ? 
                            currentRoom.players.host : currentRoom.players.guest;
                        if (player && player.id === data.playerId) {
                            player.x = data.x;
                            player.y = data.y;
                        }
                    }
                    break;
                    
                case 'ping':
                    ws.send(JSON.stringify({
                        type: 'pong',
                        timestamp: data.timestamp
                    }));
                    break;
                    
                case 'chat':
                    if (currentRoom) {
                        currentRoom.broadcast({
                            type: 'chat',
                            message: data.message,
                            sender: data.sender
                        });
                    }
                    break;
            }
        } catch (err) {
            console.error('Ошибка обработки сообщения:', err);
        }
    });
    
    ws.on('close', () => {
        if (currentRoom) {
            if (gameLoopInterval) {
                clearInterval(gameLoopInterval);
            }
            const removed = currentRoom.removePlayer(ws);
            if (removed && currentRoom.host === null && currentRoom.guest === null) {
                rooms.delete(currentRoom.roomId);
                console.log(`❌ Комната ${currentRoom.roomId} удалена`);
            }
        }
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║   🎮 WebSocket Game Server запущен!              ║
    ╠══════════════════════════════════════════════════╣
    ║   Локальный: http://localhost:${PORT}              ║
    ║   Для доступа из интернета:                      ║
    ║   ngrok http ${PORT}                               ║
    ╚══════════════════════════════════════════════════╝
    `);
});