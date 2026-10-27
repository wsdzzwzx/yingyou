<?php
/**
 * api/game.php — 学生端：游戏会话与埋点上报
 * 所有上报接口在会话不存在时静默成功（code=0 + dropped 标记），
 * 避免埋点报错影响游戏播放（前端还有本地队列重试兜底）。
 */

/** POST /api/game/start  {student_id} → {record_id, start_time} */
function game_start()
{
    req_need(array('student_id'));
    $sid = (string)req_param('student_id');
    $st = db()->prepare('SELECT student_id FROM students WHERE student_id = ?');
    $st->execute(array($sid));
    if (!$st->fetch()) json_fail(404, '学生不存在，请重新录入身份');

    $rid = biz_id('r');
    $ins = db()->prepare('INSERT INTO game_sessions (record_id, student_id, start_time) VALUES (?,?,NOW())');
    $ins->execute(array($rid, $sid));
    json_ok(array('record_id' => $rid));
}

/** POST /api/game/reportTrace  {record_id, node_id, choice_id?, node_title?, choice_text?} */
function game_reportTrace()
{
    $rid = (string)req_param('record_id');
    $nodeId = (int)req_param('node_id');
    $choiceId = req_param('choice_id');
    if (!$rid || !$nodeId) json_fail(400, '参数缺失');
    $rec = need_record($rid);

    $choiceVal = ($choiceId !== null && $choiceId !== '') ? (int)$choiceId : null;
    $nodeTitle = trim((string)req_param('node_title'));
    $choiceText = trim((string)req_param('choice_text'));

    /* 老库可能没有这两个字段（未跑过最新 install.php），自动降级为只存编号 */
    if (table_has_column('game_node_trace', 'choice_text')) {
        $ins = db()->prepare('INSERT INTO game_node_trace (trace_id, record_id, node_id, choice_id, node_title, choice_text, enter_time)'
            . ' VALUES (?,?,?,?,?,?,NOW())');
        $ins->execute(array(biz_id('t'), $rid, $nodeId, $choiceVal,
            $nodeTitle !== '' ? mb_substr($nodeTitle, 0, 80) : null,
            $choiceText !== '' ? mb_substr($choiceText, 0, 150) : null));
    } else {
        $ins = db()->prepare('INSERT INTO game_node_trace (trace_id, record_id, node_id, choice_id, enter_time) VALUES (?,?,?,?,NOW())');
        $ins->execute(array(biz_id('t'), $rid, $nodeId, $choiceVal));
    }
    json_ok();
}

/** POST /api/game/reportLoop  {record_id, loop_node_id} — 同会话同节点聚合计数 */
function game_reportLoop()
{
    $rid = (string)req_param('record_id');
    $loopNode = (int)req_param('loop_node_id');
    if (!$rid || !$loopNode) json_fail(400, '参数缺失');
    need_record($rid);

    $pdo = db();
    $st = $pdo->prepare('SELECT loop_id, enter_count FROM game_loop_record WHERE record_id = ? AND loop_node_id = ?');
    $st->execute(array($rid, $loopNode));
    $row = $st->fetch();
    if ($row) {
        $upd = $pdo->prepare('UPDATE game_loop_record SET enter_count = enter_count + 1, last_enter_time = NOW() WHERE loop_id = ?');
        $upd->execute(array($row['loop_id']));
    } else {
        $ins = $pdo->prepare('INSERT INTO game_loop_record (loop_id, record_id, loop_node_id, enter_count, last_enter_time) VALUES (?,?,?,1,NOW())');
        $ins->execute(array(biz_id('l'), $rid, $loopNode));
    }
    json_ok();
}

/** POST /api/game/reportQte  {record_id, qte_name, qte_type, is_success, cost_ms, attempt_count} */
function game_reportQte()
{
    $rid = (string)req_param('record_id');
    $name = mb_substr((string)req_param('qte_name'), 0, 50);
    $type = mb_substr((string)req_param('qte_type'), 0, 20);
    $success = (int)req_param('is_success') ? 1 : 0;
    $costMs = (int)req_param('cost_ms');
    $attempt = max(1, (int)req_param('attempt_count'));
    if (!$rid || $name === '') json_fail(400, '参数缺失');
    need_record($rid);

    $ins = db()->prepare('INSERT INTO game_qte_record (qte_id, record_id, qte_name, qte_type, is_success, cost_ms, attempt_count, occur_time) VALUES (?,?,?,?,?,?,?,NOW())');
    $ins->execute(array(biz_id('q'), $rid, $name, $type, $success, max(0, $costMs), $attempt));
    json_ok();
}

/** POST /api/game/reportEnding  {record_id, ending_id, ending_type} — 补充表：多次结局都可上报 */
function game_reportEnding()
{
    $rid = (string)req_param('record_id');
    $endingId = (int)req_param('ending_id');
    $endingType = mb_substr((string)req_param('ending_type'), 0, 20);
    if (!$rid || !$endingId) json_fail(400, '参数缺失');
    need_record($rid);

    $ins = db()->prepare('INSERT INTO game_ending_record (record_id, ending_id, ending_type, occur_time) VALUES (?,?,?,NOW())');
    $ins->execute(array($rid, $endingId, $endingType));
    json_ok();
}

/** POST /api/game/end  {record_id, is_complete?, ending_id?, total_cost_sec?} */
function game_end()
{
    $rid = (string)req_param('record_id');
    if (!$rid) json_fail(400, '参数缺失');
    $rec = need_record($rid);

    $isComplete = (int)req_param('is_complete') ? 1 : 0;
    $endingId = req_param('ending_id') !== null && req_param('ending_id') !== '' ? (int)req_param('ending_id') : null;
    // 总耗时：前端提供优先；否则按服务端 start_time 计算（sendBeacon 关页兜底也准确）
    $cost = (int)req_param('total_cost_sec');
    if ($cost <= 0) {
        $cost = (int)((time() - strtotime($rec['start_time'])));
    }
    $cost = min($cost, 86400);

    $upd = db()->prepare('UPDATE game_sessions SET end_time = NOW(), total_cost_sec = ?, is_complete = ?, end_ending_id = COALESCE(?, end_ending_id) WHERE record_id = ?');
    $upd->execute(array($cost, $isComplete, $endingId, $rid));
    json_ok();
}
