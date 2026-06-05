// ===== 게임 로직 엔진 =====

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function calcCardHP(card, position) {
  const base = 500 * card.level;
  return position === 'attack' ? base + (card.atk || 0) : base + (card.def || 0);
}

function createCardInstance(card, position = 'attack') {
  const hp = calcCardHP(card, position);
  return {
    ...card,
    instanceId: `${card.id}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    position,           // 'attack' | 'defense'
    currentHP: hp,
    maxHP: hp,
    currentATK: card.atk || 0,
    currentDEF: card.def || 0,
    defBroken: false,   // 방어력 완전히 깎였는지
    canAttack: false,   // 소환된 턴엔 false, 다음 턴부터 true
    changedPositionThisTurn: false,
    equipCards: [],     // 장착된 마법 카드
    stacks: {},         // 효과 스택 (눈물 등)
    isSummoned: false,
    isNeutralized: false, // 무력화 상태
    bombTurns: 0,         // 폭탄 효과 남은 턴
    buffATK: 0,
    buffDEF: 0,
  };
}

function createGameState(player1Id, player2Id, deck1, deck2) {
  const p1Deck = shuffle(deck1);
  const p2Deck = shuffle(deck2);

  const makePlayer = (id, deck, isFirst) => ({
    id,
    hp: 12000,
    maxHP: 12000,
    deck: deck.slice(5),
    hand: deck.slice(0, 5),
    // 필드
    normalZone: [null, null, null],       // 일반 소환 구역 3칸
    specialZone: [null, null],            // 특수 소환 구역 2칸
    spellTrapZone: [null, null, null],    // 마법/함정 구역 3칸 (set 여부 포함)
    fieldMagicZone: null,                 // 필드 마법 구역
    graveyard: [],
    // 상태
        normalSummonedThisTurn: false,
    hasAttackedThisTurn: false,
    drawnThisTurn: false,
    isFirstTurn: isFirst,
    spellsUsedThisTurn: 0,
    // 1회성 사용 추적
    usedOnceCards: new Set(),
  });

  return {
    gameId: `game_${Date.now()}`,
    phase: 'playing',     // 'playing' | 'ended'
    turn: 1,
    currentPlayer: player1Id,  // 선공 플레이어
    players: {
      [player1Id]: makePlayer(player1Id, p1Deck, true),
      [player2Id]: makePlayer(player2Id, p2Deck, false),
    },
    winner: null,
    log: ['게임 시작! 선공 플레이어는 드로우와 공격을 할 수 없습니다.'],
    player1Id,
    player2Id,
  };
}

// 필드 위 모든 몬스터 카드 반환
function getFieldMonsters(player) {
  return [
    ...player.normalZone.filter(Boolean),
    ...player.specialZone.filter(Boolean),
  ];
}

// 필드 위 모든 마법/함정 카드 반환
function getFieldSpells(player) {
  return [
    ...player.spellTrapZone.filter(Boolean),
    player.fieldMagicZone,
  ].filter(Boolean);
}

// 상대 플레이어 ID 반환
function getOpponentId(state, playerId) {
  return playerId === state.player1Id ? state.player2Id : state.player1Id;
}

// 빈 슬롯 찾기
function findEmptySlot(zone) {
  return zone.findIndex(slot => slot === null);
}

// 카드를 필드에서 찾기
function findCardOnField(player, instanceId) {
  for (let i = 0; i < player.normalZone.length; i++) {
    if (player.normalZone[i]?.instanceId === instanceId)
      return { zone: 'normalZone', index: i };
  }
  for (let i = 0; i < player.specialZone.length; i++) {
    if (player.specialZone[i]?.instanceId === instanceId)
      return { zone: 'specialZone', index: i };
  }
  for (let i = 0; i < player.spellTrapZone.length; i++) {
    if (player.spellTrapZone[i]?.instanceId === instanceId)
      return { zone: 'spellTrapZone', index: i };
  }
  return null;
}

function removeFromField(player, instanceId) {
  const loc = findCardOnField(player, instanceId);
  if (loc) {
    const card = player[loc.zone][loc.index];
    player[loc.zone][loc.index] = null;
    return card;
  }
  if (player.fieldMagicZone?.instanceId === instanceId) {
    const card = player.fieldMagicZone;
    player.fieldMagicZone = null;
    return card;
  }
  return null;
}

// ===== 효과 처리 =====

function applyOnSummonEffect(state, playerId, card, log) {
  const player = state.players[playerId];
  const oppId = getOpponentId(state, playerId);
  const opp = state.players[oppId];

  switch (card.id) {
    case 'blue_eyes_yongjun': {
      // 소환 성공 시 상대에게 공격력 X 3 피해
      const dmg = card.currentATK * 3;
      opp.hp -= dmg;
      log.push(`[효과] 푸른 눈의 이용준 소환! 상대에게 ${dmg} 피해!`);
      break;
    }
    case 'galaxy_yongjunman': {
      // 특수소환 시 제물 공격력 합계 = 별도 처리 (summonSpecial에서)
      break;
    }
    case 'goblin': {
      // 특수소환 성공 시 처리는 별도 액션으로
      break;
    }
    case 'ailen': {
      // 필드 마법/함정 수 X 600 공격력
      const spellCount = getFieldSpells(player).length + getFieldSpells(opp).length;
      card.buffATK += spellCount * 600;
      card.currentATK += spellCount * 600;
      log.push(`[효과] 에일리언 이건: 마법/함정 ${spellCount}장 x600 = +${spellCount * 600} 공격력`);
      break;
    }
    case 'beach': {
      applyBeachEffect(state, playerId, card, log);
      break;
    }
    case 'cyberphunk': {
      // 방어표시 소환 시, 처음 공격 받을 때 처리 (전투 시 적용)
      break;
    }
    default:
      break;
  }
}

function applyBeachEffect(state, playerId, card, log) {
  const player = state.players[playerId];
  const oppId = getOpponentId(state, playerId);
  const opp = state.players[oppId];
  const humanCount = [
    ...getFieldMonsters(player),
    ...getFieldMonsters(opp),
  ].filter(c => c.race === '인간족').length;

  const defBonus = humanCount * 1100;
  card.currentDEF = (card.def || 0) + 1000 + defBonus;
  card.currentATK = Math.floor(card.currentDEF * 0.7);
  log.push(`[효과] 해수욕장의 김승유: 인간족 ${humanCount}명 → DEF +${defBonus}, ATK=${card.currentATK}`);
}

function applyStartOfTurnEffects(state, playerId, log) {
  const player = state.players[playerId];
  const oppId = getOpponentId(state, playerId);
  const opp = state.players[oppId];
  const allMonsters = getFieldMonsters(player);

  for (const card of allMonsters) {
    // 리틀 김승유 - 매 턴 눈물 스택 +1
    if (card.id === 'little_kim_seungyu') {
      card.stacks.tear = (card.stacks.tear || 0) + 1;
      card.currentATK = (card.atk || 0) + card.stacks.tear * 500;
      card.currentDEF = (card.def || 0) + card.stacks.tear * 500;
      log.push(`[효과] 리틀 김승유 눈물 스택 ${card.stacks.tear}개 → ATK/DEF +${card.stacks.tear * 500}`);
    }

    // 해수욕장의 김승유 - 매 턴 재계산
    if (card.id === 'beach') {
      applyBeachEffect(state, playerId, card, log);
    }

    // 에일리언 이건 - 사용된 마법 수 X 700 방어력
    if (card.id === 'ailen') {
      const usedSpells = state.players[playerId].spellsUsedThisTurn || 0;
      card.currentDEF = (card.def || 0) + usedSpells * 700;
    }

    // 뼈해장국 이건 - 필드 전체 카드에 600 피해, 자신은 1000 피해
    if (card.id === 'bone_geon') {
      log.push(`[효과] 뼈해장국먹는 이건: 필드 전체 600 피해, 자신 1000 피해`);
      for (const m of getFieldMonsters(player)) {
        if (m.instanceId !== card.instanceId) m.currentHP -= 600;
      }
      for (const m of getFieldMonsters(opp)) {
        m.currentHP -= 600;
      }
      card.currentHP -= 1000;

      // 피해로 파괴된 카드 처리
      cleanDestroyedCards(state, playerId, log);
      cleanDestroyedCards(state, oppId, log);
    }

    // 폭탄 카운트다운 (학교에 가본 적 없는 김승유 효과)
    if (card.bombTurns > 0) {
      card.bombTurns--;
      if (card.bombTurns === 0) {
        opp.hp -= 500;
        log.push(`[효과] 폭탄 폭발! 상대에게 500 직접 피해!`);
      }
    }
  }
}

function cleanDestroyedCards(state, playerId, log) {
  const player = state.players[playerId];

  const checkZone = (zone) => {
    for (let i = 0; i < player[zone].length; i++) {
      const card = player[zone][i];
      if (card && card.currentHP <= 0) {
        log.push(`[파괴] ${card.name} 파괴 → 무덤`);
        player.graveyard.push(card);
        player[zone][i] = null;
      }
    }
  };

  checkZone('normalZone');
  checkZone('specialZone');
}

// ===== 액션 처리 =====

function processAction(state, playerId, action) {
  const log = [];
  const player = state.players[playerId];
  const oppId = getOpponentId(state, playerId);
  const opp = state.players[oppId];

  if (state.phase === 'ended') return { state, log: ['게임이 이미 종료되었습니다.'] };
  if (state.currentPlayer !== playerId) return { state, log: ['현재 당신의 턴이 아닙니다.'] };

  switch (action.type) {
    // ─── 드로우 ───
   case 'DRAW': {
      if (player.isFirstTurn) return { state, log: ['선공 첫 턴은 드로우할 수 없습니다.'] };
      if (player.drawnThisTurn) return { state, log: ['이번 턴에 이미 드로우했습니다.'] };
      if (player.deck.length === 0) {
        // 덱 아웃 → 패배
        state.phase = 'ended';
        state.winner = oppId;
        log.push(`${playerId}의 덱이 비었습니다! ${oppId} 승리!`);
        break;
      }
      const drawn = player.deck.shift();
      player.hand.push(drawn);
      log.push(`[드로우] ${drawn.name}`);

      // 손패 제한 6장
      if (player.hand.length > 6) {
        log.push(`[손패 초과] 손패가 6장을 초과했습니다. 1장을 선택해 버려주세요. (discard 액션 필요)`);
      }
      break;
    }

    // ─── 손패 버리기 ───
    case 'DISCARD': {
      const idx = player.hand.findIndex(c => c.id === action.cardId);
      if (idx === -1) return { state, log: ['손패에 해당 카드가 없습니다.'] };
      const [discarded] = player.hand.splice(idx, 1);
      player.graveyard.push(discarded);
      state.pendingDiscard = null;
      log.push(`[버리기] ${discarded.name} → 무덤`);
      break;
    }

    // ─── 일반 소환 ───
    case 'NORMAL_SUMMON': {
      if (player.normalSummonedThisTurn) return { state, log: ['이번 턴에 이미 일반 소환했습니다.'] };
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx === -1) return { state, log: ['손패에 해당 카드가 없습니다.'] };
      const card = player.hand[cardIdx];
      if (card.cardType !== 'monster') return { state, log: ['몬스터 카드만 소환할 수 있습니다.'] };
      if (card.level > 5) return { state, log: ['6성 이상은 일반 소환 불가 (특수 소환 필요).'] };

      // 커피를 마신 이건: 방어 표시 소환 불가
      if (card.id === 'coffee_geon' && action.position === 'defense') {
        opp.hp; // 즉시 파괴
        player.hand.splice(cardIdx, 1);
        player.graveyard.push(card);
        log.push(`[효과] 커피를 마신 이건은 방어 표시 소환 불가 → 즉시 파괴`);
        break;
      }

      // 왕의 근위병 김승유: 공격 표시 불가
      if (card.id === 'king' && action.position === 'attack') {
        return { state, log: ['왕의 근위병 김승유는 공격 표시로 소환할 수 없습니다.'] };
      }

      // 갤럭시 연수맨: 공격 표시 불가
      if (card.id === 'gal' && action.position === 'attack') {
        return { state, log: ['갤럭시 연수맨은 공격 표시로 소환할 수 없습니다.'] };
      }

      const slot = findEmptySlot(player.normalZone);
      if (slot === -1) return { state, log: ['일반 소환 구역이 꽉 찼습니다.'] };

      const instance = createCardInstance(card, action.position || 'attack');
      instance.canAttack = false;
      instance.isSummoned = true;
      player.hand.splice(cardIdx, 1);
      player.normalZone[slot] = instance;
      player.normalSummonedThisTurn = true;

      log.push(`[소환] ${card.name} → ${action.position === 'defense' ? '방어' : '공격'} 표시 (HP:${instance.currentHP})`);
      applyOnSummonEffect(state, playerId, instance, log);

      // 방어 표시 & 카페인 체크
      if (card.id === 'coffee_geon' && action.position === 'defense') {
        player.normalZone[slot] = null;
        player.graveyard.push(instance);
        log.push(`[효과] 카페인 중독 → 즉시 파괴`);
      }

      // blue_eyes_yongjun 소환 효과 후 HP 체크
      checkWinCondition(state, log);
      break;
    }

    // ─── 특수 소환 ───
    case 'SPECIAL_SUMMON': {
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx === -1) return { state, log: ['손패에 해당 카드가 없습니다.'] };
      const card = player.hand[cardIdx];
      if (card.cardType !== 'monster') return { state, log: ['몬스터 카드만 소환할 수 있습니다.'] };

      // 제물 카드 확인
      const tributeIds = action.tributeIds || [];
      let tributeTotal = 0;
      const tributeCards = [];

      for (const tid of tributeIds) {
        const loc = findCardOnField(player, tid);
        if (!loc) return { state, log: [`제물 카드를 필드에서 찾을 수 없습니다: ${tid}`] };
        const tc = player[loc.zone][loc.index];
        tributeTotal += (tc.currentATK || 0) + (tc.currentDEF || 0);
        tributeCards.push({ card: tc, loc });
      }

      const cardTotal = (card.atk || 0) + (card.def || 0);
      if (tributeTotal <= cardTotal && card.id !== 'dark_dragon_rider_yongjunman') {
        return { state, log: [`제물 합산(${tributeTotal}) > 카드 합산(${cardTotal}) 이어야 합니다.`] };
      }

      // 임채환 MK II - 잘린손톱 3개 필요
      if (card.id === 'MK') {
        const nailCount = tributeCards.filter(t => t.card.id === 'hand').length;
        if (nailCount < 3) return { state, log: ['임채환 MK II는 잘린손톱 3개를 제물로 바쳐야 합니다.'] };
      }

      // 특수 소환 구역 확인
      const slot = findEmptySlot(player.specialZone);
      if (slot === -1) return { state, log: ['특수 소환 구역이 꽉 찼습니다.'] };

      // 제물 제거
      for (const { card: tc, loc } of tributeCards) {
        player[loc.zone][loc.index] = null;
        player.graveyard.push(tc);
        log.push(`[제물] ${tc.name} → 무덤`);
      }

      const instance = createCardInstance(card, action.position || 'attack');
      instance.canAttack = false;
      instance.isSummoned = true;

      // 다크 드래곤 라이더: 제물 수 × 원래 공격력
      if (card.id === 'dark_dragon_rider_yongjunman') {
        const bonus = (card.atk || 0) * tributeCards.length;
        instance.currentATK = bonus;
        log.push(`[효과] 다크 드래곤 라이더: 제물 ${tributeCards.length}개 × ${card.atk} = ATK ${bonus}`);
      }

      // 갤럭시 용준맨: 제물들의 공격력 합
      if (card.id === 'galaxy_yongjunman') {
        const atkSum = tributeCards.reduce((s, t) => s + (t.card.currentATK || 0), 0);
        instance.currentATK = atkSum;
        log.push(`[효과] 갤럭시 용준맨: 제물 공격력 합 ${atkSum} 획득`);
      }

      player.hand.splice(cardIdx, 1);
      player.specialZone[slot] = instance;

      log.push(`[특수소환] ${card.name} → ${action.position === 'defense' ? '방어' : '공격'} 표시 (HP:${instance.currentHP})`);
      applyOnSummonEffect(state, playerId, instance, log);
      checkWinCondition(state, log);
      break;
    }

    // ─── 표시 변경 ───
    case 'CHANGE_POSITION': {
      const loc = findCardOnField(player, action.instanceId);
      if (!loc || loc.zone === 'spellTrapZone') return { state, log: ['카드를 찾을 수 없습니다.'] };
      const card = player[loc.zone][loc.index];
      if (card.changedPositionThisTurn) return { state, log: ['이미 이번 턴에 표시를 변경했습니다.'] };

      card.position = card.position === 'attack' ? 'defense' : 'attack';
      card.changedPositionThisTurn = true;
      card.canAttack = false;
      log.push(`[표시 변경] ${card.name} → ${card.position === 'defense' ? '방어' : '공격'} 표시`);
      break;
    }

    // ─── 공격 ───
    case 'ATTACK': {
      if (player.isFirstTurn) return { state, log: ['선공 첫 턴은 공격할 수 없습니다.'] };

      const attackerLoc = findCardOnField(player, action.attackerInstanceId);
      if (!attackerLoc) return { state, log: ['공격 카드를 찾을 수 없습니다.'] };
      const attacker = player[attackerLoc.zone][attackerLoc.index];

      if (!attacker.canAttack) return { state, log: ['이 카드는 이번 턴에 공격할 수 없습니다.'] };
      if (attacker.position !== 'attack') return { state, log: ['공격 표시 카드만 공격할 수 있습니다.'] };
      if (attacker.isNeutralized) return { state, log: ['이 카드는 무력화 상태입니다.'] };
      if (attacker.changedPositionThisTurn) return { state, log: ['표시를 변경한 카드는 공격할 수 없습니다.'] };

      const oppMonsters = getFieldMonsters(opp);

      // 직접 공격
      if (action.targetType === 'player') {
        if (oppMonsters.length > 0) return { state, log: ['상대 필드에 몬스터가 있어 직접 공격 불가.'] };
        if (attacker.id === 'galaxy_yongjunman') return { state, log: ['갤럭시 용준맨은 직접 공격 불가.'] };
        if (attacker.id === 'goblin') return { state, log: ['고블린 조련사 용준은 직접 공격 불가.'] };

        let dmg = attacker.currentATK;

        // 학교에 가본 적 없는 김승유 - 직접 공격 시 폭탄 부착
        if (attacker.id === 'school') {
          opp.bombTurns = 2;
          log.push(`[효과] 폭탄 부착! 2턴 후 500 직접 피해!`);
        }

        // 높은 산의 김승유 - 추가 데미지 없음 (직접 공격)
        opp.hp -= dmg;
        attacker.canAttack = false;
        log.push(`[직접공격] ${attacker.name} → 상대 플레이어 ${dmg} 피해! (상대 HP: ${opp.hp})`);
        checkWinCondition(state, log);
        break;
      }

      // 몬스터 공격
      const targetLoc = findCardOnField(opp, action.targetInstanceId);
      if (!targetLoc) return { state, log: ['대상 카드를 찾을 수 없습니다.'] };
      const target = opp[targetLoc.zone][targetLoc.index];

      let attackPower = attacker.currentATK;

      // 임채환의 검사의 길 - 검 사용 카드 공격 시 공격력 절반
      if (attacker.id === 'sword') {
        const swordCards = ['sword', 'black', 'MK'];
        if (swordCards.includes(target.id)) {
          attackPower = Math.floor(attackPower / 2);
          log.push(`[효과] 검사의 길: 검 카드 공격 시 공격력 절반 (${attackPower})`);
        }
      }

      // 바니걸 김연수 - 인간족 공격 시 +500
      if (attacker.id === 'bunny' && target.race === '인간족') {
        attackPower += 500;
        log.push(`[효과] 바니걸 김연수: 인간족 공격 +500`);
      }

      // 2077년의 김연수 - 방어표시 소환 후 첫 공격 받을 때 공격력 차이만큼 ATK 획득
      if (target.id === 'cyberphunk' && target.position === 'defense' && !target.stacks.cyberBuff) {
        const diff = Math.max(0, attackPower - target.currentATK);
        target.currentATK += diff;
        target.stacks.cyberBuff = true;
        log.push(`[효과] 2077년의 김연수: 공격력 차이 +${diff} ATK 획득`);
      }

      // 높은 산의 김승유 - 자신보다 ATK 높은 카드 공격 시 +200
      if (attacker.id === 'high' && target.currentATK > attackPower) {
        attackPower += 200;
        log.push(`[효과] 높은 산의 김승유: +200 추가 데미지`);
      }

      log.push(`[전투] ${attacker.name}(ATK:${attackPower}) → ${target.name}`);

      if (target.position === 'defense') {
        if (!target.defBroken) {
          // 방어력 먼저 깎기
          if (attackPower >= target.currentDEF) {
            log.push(`[전투] ${target.name} 방어력 ${target.currentDEF} 파괴됨`);
            target.currentDEF = 0;
            target.defBroken = true;
            // 초과 데미지는 체력에 안 박힘
          } else {
            target.currentDEF -= attackPower;
            log.push(`[전투] ${target.name} 방어력 ${target.currentDEF} 남음`);
          }
        } else {
          // 방어력 이미 0 → 체력에 데미지
          target.currentHP -= attackPower;
          log.push(`[전투] ${target.name} HP ${target.currentHP} 남음`);
        }
      } else {
        // 공격 표시 - 체력에 직접 데미지
        // 커피를 마신 이건 - 공격 표시일 때 전투로 파괴 불가
        if (target.id === 'coffee_geon') {
          target.currentHP = Math.max(1, target.currentHP - attackPower);
          log.push(`[효과] 커피를 마신 이건은 전투로 파괴되지 않음`);
        } else {
          target.currentHP -= attackPower;
        }
        log.push(`[전투] ${target.name} HP ${target.currentHP} 남음`);
      }

      attacker.canAttack = false;

      // 파괴 체크
      if (target.currentHP <= 0) {
        // 김연수의 어릴시절 상상친구들 - 전투 파괴 시 덱에서 김연수 관련 카드 효과 발동
        if (target.id === 'friend') {
          const yeonsuCards = opp.deck.filter(c => c.name.includes('김연수'));
          if (yeonsuCards.length > 0) {
            const random = yeonsuCards[Math.floor(Math.random() * yeonsuCards.length)];
            log.push(`[효과] 상상친구들 파괴 → 덱의 ${random.name} 효과 발동 (구현 스킵)`);
          }
        }

        log.push(`[파괴] ${target.name} 파괴 → 무덤`);
        opp.graveyard.push(target);
        opp[targetLoc.zone][targetLoc.index] = null;
      }

      checkWinCondition(state, log);
      break;
    }

    // ─── 마법/함정 세트 ───
    case 'SET_SPELL': {
      const cardIdx = player.hand.findIndex(c => c.id === action.cardId);
      if (cardIdx === -1) return { state, log: ['손패에 해당 카드가 없습니다.'] };
      const card = player.hand[cardIdx];
      if (card.cardType !== 'spell') return { state, log: ['마법 카드만 세트할 수 있습니다.'] };

      // 필드 마법
      if (action.isFieldMagic) {
        if (player.fieldMagicZone) {
          player.graveyard.push(player.fieldMagicZone);
          log.push(`[파괴] 기존 필드 마법 ${player.fieldMagicZone.name} → 무덤`);
        }
        const instance = createCardInstance(card);
        instance.isSet = false;
        player.fieldMagicZone = instance;
        player.hand.splice(cardIdx, 1);
        log.push(`[필드 마법 배치] ${card.name}`);
        break;
      }

      const slot = findEmptySlot(player.spellTrapZone);
      if (slot === -1) return { state, log: ['마법/함정 구역이 꽉 찼습니다.'] };

      const instance = createCardInstance(card);
      instance.isSet = true; // 엎어두기
      player.hand.splice(cardIdx, 1);
      player.spellTrapZone[slot] = instance;
      log.push(`[세트] 마법/함정 카드 세트됨`);
      break;
    }

    // ─── 마법 발동 ───
    case 'ACTIVATE_SPELL': {
      // 필드에 세트된 마법 또는 손패에서 즉시 발동
      let card = null;
      let fromField = false;
      let fieldLoc = null;

      // 필드에서 찾기
      const fl = findCardOnField(player, action.instanceId);
      if (fl && fl.zone === 'spellTrapZone') {
        card = player[fl.zone][fl.index];
        fromField = true;
        fieldLoc = fl;
      }

      if (!card) return { state, log: ['마법 카드를 찾을 수 없습니다.'] };

      // 1회성 체크
      if (player.usedOnceCards.has(card.id)) {
        return { state, log: [`${card.name}은 게임당 한 번만 사용 가능합니다.`] };
      }

      const result = activateSpell(state, playerId, card, action, log);
      if (!result.success) return { state, log: result.log };

      // 단발성 마법은 무덤으로
      if (fromField) {
        player[fieldLoc.zone][fieldLoc.index] = null;
      }
      player.graveyard.push(card);
      player.spellsUsedThisTurn = (player.spellsUsedThisTurn || 0) + 1;
      log.push(...result.log);

      // 1회성 마법 등록
      const onceIds = ['paper', 'masturbation', 'love'];
      if (onceIds.includes(card.id)) player.usedOnceCards.add(card.id);

      checkWinCondition(state, log);
      break;
    }

    // ─── 고블린 효과 발동 ───
    case 'GOBLIN_EFFECT': {
      const loc = findCardOnField(player, action.goblinInstanceId);
      if (!loc) return { state, log: ['고블린 조련사 용준을 찾을 수 없습니다.'] };

      // 대상 카드 찾기 (아군/적군 모두 가능)
      let targetCard = null;
      let targetOwner = null;
      let targetLoc2 = null;

      for (const [pid, p] of Object.entries(state.players)) {
        const tl = findCardOnField(p, action.targetInstanceId);
        if (tl) { targetCard = p[tl.zone][tl.index]; targetOwner = pid; targetLoc2 = tl; }
      }

      if (!targetCard) return { state, log: ['대상 카드를 찾을 수 없습니다.'] };

      const originalATK = targetCard.currentATK;
      targetCard.isGoblin = true;
      targetCard.currentATK = originalATK * 2;
      targetCard.currentDEF = 0;
      log.push(`[효과] 고블린 조련사: ${targetCard.name} 고블린화! ATK ${targetCard.currentATK}, DEF 0`);
      break;
    }

    // ─── 턴 종료 ───
    case 'END_TURN': {
      // 다음 턴 준비
      player.isFirstTurn = false;
      player.normalSummonedThisTurn = false;
      player.spellsUsedThisTurn = 0;
      player.drawnThisTurn = false;

      // 공격 가능 초기화
      for (const card of getFieldMonsters(player)) {
        card.canAttack = true;
        card.changedPositionThisTurn = false;
      }

      state.turn += 0.5; // 0.5씩 증가 → 정수가 되면 1페이즈 완료
      state.currentPlayer = oppId;

      log.push(`[턴 종료] → ${oppId}의 턴`);

      // 다음 플레이어 턴 시작 효과
      applyStartOfTurnEffects(state, oppId, log);

      // 자동 드로우 (선공 첫 턴 아닌 경우)
      const nextPlayer = state.players[oppId];
      if (!nextPlayer.isFirstTurn) {
        if (nextPlayer.deck.length > 0) {
          const drawn = nextPlayer.deck.shift();
          nextPlayer.hand.push(drawn);
          nextPlayer.drawnThisTurn = true;
          log.push(`[드로우] ${drawn.name}`);
          if (nextPlayer.hand.length > 6) {
            state.pendingDiscard = oppId;
            log.push(`[손패 초과] ${oppId}의 손패가 6장 초과. 1장을 버려주세요.`);
          }
        } else {
          state.phase = 'ended';
          state.winner = playerId;
          log.push(`[덱 아웃] ${oppId}의 덱이 비었습니다! ${playerId} 승리!`);
        }
      }
      break;
    }

    default:
      return { state, log: [`알 수 없는 액션: ${action.type}`] };
  }

  return { state, log };
}

// ===== 마법 발동 처리 =====
function activateSpell(state, playerId, card, action, log) {
  const player = state.players[playerId];
  const oppId = getOpponentId(state, playerId);
  const opp = state.players[oppId];
  const result = { success: true, log: [] };

  switch (card.id) {
    case 'paper': {
      // 체력이 더 낮은 플레이어 쪽으로 양쪽 체력 설정
      const lower = Math.min(player.hp, opp.hp);
      player.hp = lower;
      opp.hp = lower;
      result.log.push(`[마법] 이건의 딸휴지: 양측 체력 ${lower}으로 동기화`);
      break;
    }
    case 'blue': {
      // 장착 마법: 대상 카드에 장착
      const targetLoc = findCardOnField(player, action.targetInstanceId) ||
                        findCardOnField(opp, action.targetInstanceId);
      if (!targetLoc) { result.success = false; result.log.push('장착 대상을 찾을 수 없습니다.'); break; }
      const ownerP = action.targetOwner === playerId ? player : opp;
      const targetCard = ownerP[targetLoc.zone][targetLoc.index];
      targetCard.equipCards = targetCard.equipCards || [];
      targetCard.equipCards.push({ ...card });
      targetCard.hasBlueEquip = true;
      result.log.push(`[마법] 태초의 푸른눈의 용준 장착: ${targetCard.name} 전투 파괴 불가`);
      break;
    }
    case 'shout': {
      // 아군 카드 방어력 +500 (게임 끝까지)
      for (const m of getFieldMonsters(player)) {
        m.currentDEF += 500;
        m.buffDEF = (m.buffDEF || 0) + 500;
      }
      result.log.push(`[마법] 용준의 깊은 결의: 아군 전체 DEF +500`);
      break;
    }
    case 'masturbation': {
      // 무작위 적 카드 사용 불가
      const oppMonsters = getFieldMonsters(opp);
      if (oppMonsters.length === 0) { result.success = false; result.log.push('적 카드가 없습니다.'); break; }
      const target = oppMonsters[Math.floor(Math.random() * oppMonsters.length)];
      target.isNeutralized = true;
      result.log.push(`[마법] 자위 후의 김승유: ${target.name} 사용 불가!`);
      break;
    }
    case 'dick': {
      // 무작위 적 공격 표시 카드 무력화, 막으면 3장 드로우
      const atkCards = getFieldMonsters(opp).filter(m => m.position === 'attack');
      if (atkCards.length === 0) { result.success = false; result.log.push('무력화할 공격 표시 카드가 없습니다.'); break; }
      const target = atkCards[Math.floor(Math.random() * atkCards.length)];
      // 간단 구현: 항상 무력화 (막는 기능은 별도 액션으로 구현 가능)
      target.isNeutralized = true;
      result.log.push(`[마법] 김연수의 4달 묵은 좆밥: ${target.name} 무력화`);
      break;
    }
    case 'dairy': {
      // 적 방어 표시 카드 → 공격 표시 전환, ATK 절반, ATK≤300이면 파괴
      const defCards = getFieldMonsters(opp).filter(m => m.position === 'defense');
      for (const m of defCards) {
        m.position = 'attack';
        m.currentATK = Math.floor(m.currentATK / 2);
        result.log.push(`[마법] 일기장: ${m.name} 공격 표시 전환, ATK ${m.currentATK}`);
        if (m.currentATK <= 300) {
          const tl = findCardOnField(opp, m.instanceId);
          opp.graveyard.push(m);
          opp[tl.zone][tl.index] = null;
          result.log.push(`[파괴] ${m.name} ATK≤300 → 파괴`);
        }
      }
      break;
    }
    case 'potato': {
      // 상대 카드 하나 ATK 절반
      const targetLoc = findCardOnField(opp, action.targetInstanceId);
      if (!targetLoc) { result.success = false; result.log.push('대상을 찾을 수 없습니다.'); break; }
      const targetCard = opp[targetLoc.zone][targetLoc.index];
      targetCard.currentATK = Math.floor(targetCard.currentATK / 2);
      result.log.push(`[마법] 임채환의 봉인된 영혼: ${targetCard.name} ATK → ${targetCard.currentATK}`);
      break;
    }
    case 'torii': {
      // 장착: ATK +500, 아이돌 선언이면 +1300 ATK, -500 DEF
      const targetLoc = findCardOnField(player, action.targetInstanceId);
      if (!targetLoc) { result.success = false; result.log.push('장착 대상을 찾을 수 없습니다.'); break; }
      const targetCard = player[targetLoc.zone][targetLoc.index];
      if (targetCard.id === 'idol') {
        targetCard.currentATK += 1300;
        targetCard.currentDEF -= 500;
        result.log.push(`[마법] 토리이: 아이돌 선언 → ATK +1300, DEF -500`);
      } else {
        targetCard.currentATK += 500;
        result.log.push(`[마법] 토리이: ATK +500`);
      }
      break;
    }
    case 'love': {
      // 체력 600 회복
      player.hp = Math.min(player.maxHP, player.hp + 600);
      result.log.push(`[마법] 김연수의 순정: HP +600 (현재: ${player.hp})`);
      break;
    }
    default:
      result.log.push(`[마법] ${card.name} 발동`);
      break;
  }

  return result;
}

// ===== 승리 조건 =====
function checkWinCondition(state, log) {
  for (const [pid, player] of Object.entries(state.players)) {
    if (player.hp <= 0) {
      state.phase = 'ended';
      state.winner = getOpponentId(state, pid);
      log.push(`[게임 종료] ${pid} HP 0! ${state.winner} 승리!`);
    }
  }
}

module.exports = {
  createGameState,
  processAction,
  getFieldMonsters,
  getFieldSpells,
  getOpponentId,
};
