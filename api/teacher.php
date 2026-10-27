<?php
/**
 * api/teacher.php — 教师端：登录、班级管理、数据查看、排名、导出
 */

/** POST /api/teacher/login  {account, password} → {teacher_id, name, token, is_admin} */
function teacher_login()
{
    req_need(array('account', 'password'));
    $account = (string)req_param('account');
    $password = (string)req_param('password');

    $st = db()->prepare('SELECT teacher_id, teacher_name, password_hash FROM teachers WHERE account = ? LIMIT 1');
    $st->execute(array($account));
    $row = $st->fetch();
    if (!$row || !password_verify($password, $row['password_hash'])) {
        json_fail(401, '账号或密码错误');
    }
    json_ok(array(
        'teacher_id' => $row['teacher_id'],
        'name'       => $row['teacher_name'] === '' ? $account : $row['teacher_name'],
        'account'    => $account,
        'is_admin'   => teacher_is_admin($row['teacher_id']) ? 1 : 0,
        'token'      => teacher_token($row['teacher_id']),
    ));
}

/** GET /api/teacher/me → 当前登录教师信息（刷新页面后校正身份与权限） */
function teacher_me()
{
    $tid = check_teacher_auth();
    $st = db()->prepare('SELECT teacher_id, account, teacher_name, create_time FROM teachers WHERE teacher_id = ?');
    $st->execute(array($tid));
    $row = $st->fetch();
    if (!$row) json_fail(404, '教师账号不存在');
    json_ok(array(
        'teacher_id'  => $row['teacher_id'],
        'account'     => $row['account'],
        'name'        => $row['teacher_name'] === '' ? $row['account'] : $row['teacher_name'],
        'is_admin'    => teacher_is_admin($tid) ? 1 : 0,
        'create_time' => $row['create_time'],
    ));
}

/** GET /api/teacher/list → 全部教师账号（仅管理员） */
function teacher_list()
{
    check_teacher_admin();
    $hasAdmin = table_has_column('teachers', 'is_admin');
    $sql = 'SELECT t.teacher_id, t.account, t.teacher_name, t.create_time'
        . ($hasAdmin ? ', t.is_admin' : ', 0 AS is_admin')
        . ', (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = t.teacher_id) AS class_count'
        . ', (SELECT COUNT(DISTINCT r.student_id) FROM classes c'
        .     ' JOIN class_student_rel r ON r.class_id = c.class_id'
        .     ' WHERE c.teacher_id = t.teacher_id) AS student_count'
        . ' FROM teachers t ORDER BY t.create_time ASC, t.teacher_id ASC';
    $rows = db()->query($sql)->fetchAll();
    foreach ($rows as $i => $r) {
        $rows[$i]['is_admin']    = (int)$r['is_admin'];
        $rows[$i]['class_count'] = (int)$r['class_count'];
        $rows[$i]['student_count'] = (int)$r['student_count'];
        if ($rows[$i]['teacher_name'] === '') $rows[$i]['teacher_name'] = $r['account'];
    }
    json_ok(array('teachers' => $rows));
}

/** POST /api/teacher/create  {account, password, teacher_name, is_admin} — 仅管理员 */
function teacher_create()
{
    $adminId = check_teacher_admin();
    $account = trim((string)req_param('account'));
    $password = (string)req_param('password');
    $name = mb_substr(trim((string)req_param('teacher_name')), 0, 50);
    $isAdmin = (int)req_param('is_admin') === 1 ? 1 : 0;

    if (!preg_match('/^[A-Za-z0-9_@.\-]{3,50}$/', $account)) {
        json_fail(400, '账号需为 3~50 位字母、数字或 _ @ . -（不支持中文与空格）');
    }
    require_strong_password($password, '初始密码');
    if ($name === '') $name = $account;

    $st = db()->prepare('SELECT teacher_id FROM teachers WHERE account = ?');
    $st->execute(array($account));
    if ($st->fetch()) json_fail(400, '账号「' . $account . '」已存在，请换一个');

    $tid = biz_id('t');
    $hasAdmin = table_has_column('teachers', 'is_admin');
    $hash = password_hash($password, PASSWORD_DEFAULT);
    if ($hasAdmin) {
        $ins = db()->prepare('INSERT INTO teachers (teacher_id, account, password_hash, teacher_name, is_admin, create_time)'
            . ' VALUES (?,?,?,?,?,NOW())');
        $ins->execute(array($tid, $account, $hash, $name, $isAdmin));
    } else {
        $ins = db()->prepare('INSERT INTO teachers (teacher_id, account, password_hash, teacher_name, create_time)'
            . ' VALUES (?,?,?,?,NOW())');
        $ins->execute(array($tid, $account, $hash, $name));
    }
    json_ok(array('teacher_id' => $tid, 'account' => $account, 'created_by' => $adminId));
}

/** POST /api/teacher/update  {teacher_id, teacher_name, is_admin?}
 *  管理员可改任意人（含设置/取消管理员），普通教师只能改自己的姓名 */
function teacher_update()
{
    $tid = check_teacher_auth();
    $target = trim((string)req_param('teacher_id'));
    if ($target === '') $target = $tid;
    $name = mb_substr(trim((string)req_param('teacher_name')), 0, 50);
    if ($name === '') json_fail(400, '姓名不能为空');
    $isAdminLogin = teacher_is_admin($tid);
    if ($target !== $tid && !$isAdminLogin) {
        json_fail(403, '只有管理员可以修改其他教师的信息');
    }
    $st = db()->prepare('SELECT teacher_id FROM teachers WHERE teacher_id = ?');
    $st->execute(array($target));
    if (!$st->fetch()) json_fail(404, '教师账号不存在');

    /* 管理员身份变更：只有管理员能改，且不能把最后一个管理员降级 */
    $rawAdmin = req_param('is_admin');
    if ($rawAdmin !== null && $rawAdmin !== '' && table_has_column('teachers', 'is_admin')) {
        if (!$isAdminLogin) json_fail(403, '只有管理员可以调整管理员身份');
        $want = (int)$rawAdmin === 1 ? 1 : 0;
        if ($want === 0) {
            $n = (int)db()->query('SELECT COUNT(*) FROM teachers WHERE is_admin = 1')->fetchColumn();
            if ($n <= 1) json_fail(400, '至少要保留一个管理员账号');
        }
        $up = db()->prepare('UPDATE teachers SET is_admin = ? WHERE teacher_id = ?');
        $up->execute(array($want, $target));
    }

    $up2 = db()->prepare('UPDATE teachers SET teacher_name = ? WHERE teacher_id = ?');
    $up2->execute(array($name, $target));
    json_ok(array('teacher_id' => $target, 'teacher_name' => $name));
}

/** POST /api/teacher/resetPassword  {teacher_id, new_password} — 仅管理员（忘记密码时用） */
function teacher_resetPassword()
{
    check_teacher_admin();
    $target = trim((string)req_param('teacher_id'));
    $new = (string)req_param('new_password');
    if ($target === '') json_fail(400, '缺少 teacher_id');
    require_strong_password($new, '新密码');

    $st = db()->prepare('SELECT teacher_id FROM teachers WHERE teacher_id = ?');
    $st->execute(array($target));
    if (!$st->fetch()) json_fail(404, '教师账号不存在');

    $up = db()->prepare('UPDATE teachers SET password_hash = ? WHERE teacher_id = ?');
    $up->execute(array(password_hash($new, PASSWORD_DEFAULT), $target));
    json_ok(array('teacher_id' => $target));
}

/** POST /api/teacher/delete  {teacher_id} — 仅管理员；不能删自己、不能删还有班级的教师 */
function teacher_delete()
{
    $adminId = check_teacher_admin();
    $target = trim((string)req_param('teacher_id'));
    if ($target === '') json_fail(400, '缺少 teacher_id');
    if ($target === $adminId) json_fail(400, '不能删除当前登录的账号');

    $st = db()->prepare('SELECT teacher_id, account FROM teachers WHERE teacher_id = ?');
    $st->execute(array($target));
    $row = $st->fetch();
    if (!$row) json_fail(404, '教师账号不存在');

    $n = db()->prepare('SELECT COUNT(*) FROM classes WHERE teacher_id = ?');
    $n->execute(array($target));
    $classCount = (int)$n->fetchColumn();
    if ($classCount > 0) {
        json_fail(400, '该教师名下还有 ' . $classCount . ' 个班级，请先在对方账号或管理员视角清空班级后再删除');
    }

    $del = db()->prepare('DELETE FROM teachers WHERE teacher_id = ?');
    $del->execute(array($target));
    json_ok(array('deleted' => $row['account']));
}

/** GET /api/teacher/myClass  → {classes:[{class_id,class_name,student_count,create_time}]} */
function teacher_myClass()
{
    $tid = check_teacher_auth();
    $st = db()->prepare(
        'SELECT c.class_id, c.class_name, c.create_time,
                (SELECT COUNT(*) FROM class_student_rel r WHERE r.class_id = c.class_id) AS student_count
         FROM classes c WHERE c.teacher_id = ? ORDER BY c.create_time DESC'
    );
    $st->execute(array($tid));
    json_ok(array('classes' => $st->fetchAll()));
}

/** POST /api/class/create  {class_name} → {class_id} */
function class_create()
{
    $tid = check_teacher_auth();
    $name = mb_substr((string)req_param('class_name'), 0, 50);
    if ($name === '') json_fail(400, '班级名称不能为空');

    $cid = biz_id('c');
    $ins = db()->prepare('INSERT INTO classes (class_id, teacher_id, class_name, create_time) VALUES (?,?,?,NOW())');
    $ins->execute(array($cid, $tid, $name));
    json_ok(array('class_id' => $cid));
}

/** GET /api/student/unbindList  → 已上线游戏、但还没被任何班级拉走的学生
 *  matched=1 表示该学生登记时填的班级名与当前教师某个班级重名 —— 基本就是「自己的学生」。
 *  这样多教师并存时，A 老师拉走的学生不会出现在 B 老师的待选列表里。 */
function student_unbindList()
{
    $tid = check_teacher_auth();

    /* 当前教师的班级名，用于标记「可能是我的学生」 */
    $cn = db()->prepare('SELECT class_name FROM classes WHERE teacher_id = ?');
    $cn->execute(array($tid));
    $myNames = array();
    foreach ($cn->fetchAll() as $c) {
        $myNames[$c['class_name']] = true;
    }

    $st = db()->prepare(
        'SELECT s.student_id, s.class_name, s.student_name, s.phone, s.create_time,
                (SELECT COUNT(*) FROM game_sessions g WHERE g.student_id = s.student_id) AS play_count
         FROM students s
         WHERE EXISTS (SELECT 1 FROM game_sessions g WHERE g.student_id = s.student_id)
           AND NOT EXISTS (SELECT 1 FROM class_student_rel r WHERE r.student_id = s.student_id)
         ORDER BY s.create_time DESC'
    );
    $st->execute();
    $list = $st->fetchAll();
    foreach ($list as $i => $r) {
        $list[$i]['matched'] = isset($myNames[$r['class_name']]) ? 1 : 0;
    }
    /* 自己的学生排前面 */
    usort($list, 'unbind_cmp');
    json_ok(array('students' => $list));
}

function unbind_cmp($a, $b)
{
    if ($a['matched'] !== $b['matched']) return $b['matched'] - $a['matched'];
    return strcmp((string)$b['create_time'], (string)$a['create_time']);
}

/** POST /api/student/deleteUnbind  {student_ids:[]} — 删除未归班学生（仅管理员），连同其全部游戏记录 */
function student_deleteUnbind()
{
    check_teacher_admin();

    $ids = req_param('student_ids');
    if (!is_array($ids)) json_fail(400, '参数 student_ids 必须是数组');
    $ids = array_values(array_unique(array_filter(array_map('strval', $ids), 'strlen')));
    if (!$ids) json_fail(400, '请先勾选要删除的学生');

    $db = db();
    $db->beginTransaction();
    try {
        /* 只删「确实未归班」的：已在任何班级里的直接跳过，绝不误删在班学生的历史 */
        $ph = implode(',', array_fill(0, count($ids), '?'));
        $st = $db->prepare(
            "SELECT student_id FROM students
             WHERE student_id IN ($ph)
               AND NOT EXISTS (SELECT 1 FROM class_student_rel r WHERE r.student_id = students.student_id)"
        );
        $st->execute($ids);
        $valid = $st->fetchAll(PDO::FETCH_COLUMN);
        if (!$valid) {
            $db->rollBack();
            json_fail(404, '所选学生均已归班或不存在，未删除任何数据');
        }

        /* 按外键依赖顺序删：4 张明细表 → 会话 → 学生 */
        $ph = implode(',', array_fill(0, count($valid), '?'));
        $detail = array('game_node_trace', 'game_loop_record', 'game_qte_record', 'game_ending_record');
        foreach ($detail as $tbl) {
            $d = $db->prepare(
                "DELETE t FROM $tbl t JOIN game_sessions g ON g.record_id = t.record_id
                 WHERE g.student_id IN ($ph)"
            );
            $d->execute($valid);
        }
        $ds = $db->prepare("DELETE FROM game_sessions WHERE student_id IN ($ph)");
        $ds->execute($valid);
        $st2 = $db->prepare("DELETE FROM students WHERE student_id IN ($ph)");
        $st2->execute($valid);

        $db->commit();
        json_ok(array('deleted' => count($valid), 'skipped' => count($ids) - count($valid)));
    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        json_fail(500, '删除失败，已回滚');
    }
}

/** POST /api/class/addStudent  {class_id, student_ids:[]} — 批量拉入，一人可属多班 */
function class_addStudent()
{
    $tid = check_teacher_auth();
    $cid = (string)req_param('class_id');
    $ids = req_param('student_ids');
    if (!is_array($ids) || !count($ids)) json_fail(400, '未选择学生');

    $st = db()->prepare('SELECT class_id FROM classes WHERE class_id = ? AND teacher_id = ?');
    $st->execute(array($cid, $tid));
    if (!$st->fetch()) json_fail(404, '班级不存在');

    $ins = db()->prepare('INSERT IGNORE INTO class_student_rel (class_id, student_id) VALUES (?,?)');
    $n = 0;
    foreach ($ids as $sid) {
        $sid = (string)$sid;
        if ($sid === '') continue;
        $ins->execute(array($cid, $sid));
        $n += $ins->rowCount();
    }
    json_ok(array('added' => $n));
}

/** POST /api/class/delete  {class_id} — 删除班级（学生档案与其游戏记录保留，只是不再归属本班） */
function class_delete()
{
    $tid = check_teacher_auth();
    $cid = (string)req_param('class_id');
    if ($cid === '') json_fail(400, '参数缺失');

    $st = db()->prepare('SELECT class_id FROM classes WHERE class_id = ? AND teacher_id = ?');
    $st->execute(array($cid, $tid));
    if (!$st->fetch()) json_fail(404, '班级不存在');

    $pdo = db();
    try {
        $pdo->beginTransaction();
        $d1 = $pdo->prepare('DELETE FROM class_student_rel WHERE class_id = ?');
        $d1->execute(array($cid));
        $removed = $d1->rowCount();
        $d2 = $pdo->prepare('DELETE FROM classes WHERE class_id = ? AND teacher_id = ?');
        $d2->execute(array($cid, $tid));
        $pdo->commit();
    } catch (Exception $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        json_fail(500, '删除失败：' . $e->getMessage());
    }
    json_ok(array('removed_students' => $removed));
}

/** POST /api/class/removeStudent  {class_id, student_id} — 把学生移出班级（历史成绩仍保留在数据库） */
function class_removeStudent()
{
    $tid = check_teacher_auth();
    $cid = (string)req_param('class_id');
    $sid = (string)req_param('student_id');
    if ($cid === '' || $sid === '') json_fail(400, '参数缺失');

    $st = db()->prepare('SELECT class_id FROM classes WHERE class_id = ? AND teacher_id = ?');
    $st->execute(array($cid, $tid));
    if (!$st->fetch()) json_fail(404, '班级不存在');

    $del = db()->prepare('DELETE FROM class_student_rel WHERE class_id = ? AND student_id = ?');
    $del->execute(array($cid, $sid));
    json_ok(array('removed' => $del->rowCount()));
}

/** POST /api/teacher/changePassword  {old_password, new_password} — 修改当前登录教师的密码 */
function teacher_changePassword()
{
    $tid = check_teacher_auth();
    $old = (string)req_param('old_password');
    $new = (string)req_param('new_password');
    if ($old === '' || $new === '') json_fail(400, '请填写原密码与新密码');
    require_strong_password($new, '新密码');
    if ($old === $new) json_fail(400, '新密码不能与原密码相同');

    $st = db()->prepare('SELECT password_hash FROM teachers WHERE teacher_id = ?');
    $st->execute(array($tid));
    $row = $st->fetch();
    if (!$row) json_fail(404, '教师账号不存在');
    if (!password_verify($old, $row['password_hash'])) json_fail(400, '原密码不正确');

    $hash = password_hash($new, PASSWORD_DEFAULT);
    $up = db()->prepare('UPDATE teachers SET password_hash = ? WHERE teacher_id = ?');
    $up->execute(array($hash, $tid));
    json_ok();
}

/** 班级内每个学生的最优会话（通关优先 → 耗时升序 → 死循环少） */
function class_best_records($classId)
{
    $st = db()->prepare(
        'SELECT s.student_id, s.student_name, s.phone, g.record_id, g.is_complete,
                g.total_cost_sec, g.end_ending_id, g.start_time, g.end_time
         FROM class_student_rel r
         JOIN students s       ON s.student_id = r.student_id
         LEFT JOIN game_sessions g ON g.student_id = s.student_id
         WHERE r.class_id = ?'
    );
    $st->execute(array($classId));
    $rows = $st->fetchAll();

    // 汇总每个会话的死循环总次数
    $loopMap = array();
    if ($rows) {
        $in = implode(',', array_fill(0, count($rows), '?'));
        $st2 = db()->prepare(
            "SELECT record_id, COALESCE(SUM(enter_count),0) AS loop_total
             FROM game_loop_record WHERE record_id IN ($in) GROUP BY record_id"
        );
        $st2->execute(array_map(function ($r) { return $r['record_id']; }, $rows));
        foreach ($st2->fetchAll() as $l) $loopMap[$l['record_id']] = (int)$l['loop_total'];
    }

    // 每个学生取"最好的一次"：通关 > 耗时短 > 死循环少 > 最近
    $best = array();
    foreach ($rows as $r) {
        $r['loop_total'] = isset($loopMap[$r['record_id']]) ? $loopMap[$r['record_id']] : 0;
        $sid = $r['student_id'];
        if (!isset($best[$sid]) || self_better($r, $best[$sid])) $best[$sid] = $r;
    }
    $list = array_values($best);

    /* 主题（防火 / 防震）：按该会话走过的节点判定，比"猜结局"准确。
       1-4~1-9、1-19 属于火灾线；1-10~1-18 属于地震线；1-1~1-3 是共用开场不计。 */
    $rids = array();
    foreach ($list as $r) {
        if (!empty($r['record_id'])) $rids[] = $r['record_id'];
    }
    $themeMap = array();
    if ($rids) {
        $in = implode(',', array_fill(0, count($rids), '?'));
        $st3 = db()->prepare("SELECT DISTINCT record_id, node_id FROM game_node_trace WHERE record_id IN ($in)");
        $st3->execute($rids);
        foreach ($st3->fetchAll() as $t) {
            $n = (int)$t['node_id'];
            $rid = $t['record_id'];
            if (!isset($themeMap[$rid])) $themeMap[$rid] = array('fire' => false, 'quake' => false);
            if (($n >= 4 && $n <= 9) || $n === 19) $themeMap[$rid]['fire'] = true;
            if ($n >= 10 && $n <= 18) $themeMap[$rid]['quake'] = true;
        }
    }
    foreach ($list as $i => $r) {
        $th = isset($themeMap[$r['record_id']]) ? $themeMap[$r['record_id']] : null;
        if (!$th) {
            $list[$i]['theme'] = '';
        } elseif ($th['fire'] && $th['quake']) {
            $list[$i]['theme'] = '防火 / 防震';
        } else {
            $list[$i]['theme'] = $th['fire'] ? '防火' : '防震';
        }
    }

    usort($list, 'self_cmp');
    return $list;
}

function self_score($r)
{
    // 分数越小越靠前：未通关视为耗时无穷大（排在所有通关者之后）
    if ($r['is_complete'] === null) return array(2, PHP_INT_MAX, $r['loop_total']);
    return array($r['is_complete'] ? 0 : 1,
                 $r['total_cost_sec'] === null ? PHP_INT_MAX : (int)$r['total_cost_sec'],
                 (int)$r['loop_total']);
}

function self_cmp($a, $b) { return self_score($a) < self_score($b) ? -1 : (self_score($a) > self_score($b) ? 1 : 0); }
function self_better($a, $b) { return self_cmp($a, $b) < 0; }

/** GET /api/class/rank  {class_id} → {rank:[...]} */
function class_rank()
{
    $tid = check_teacher_auth();
    $cid = (string)req_param('class_id');
    $st = db()->prepare('SELECT class_id FROM classes WHERE class_id = ? AND teacher_id = ?');
    $st->execute(array($cid, $tid));
    if (!$st->fetch()) json_fail(404, '班级不存在');

    $list = class_best_records($cid);
    $rank = array(); $no = 0;
    foreach ($list as $r) {
        $rank[] = array(
            'rank'         => ++$no,
            'student_id'   => $r['student_id'],
            'student_name' => $r['student_name'],
            'phone'        => $r['phone'],
            'is_complete'  => $r['is_complete'] === null ? null : (int)$r['is_complete'],
            'theme'        => isset($r['theme']) ? $r['theme'] : '',
            'played'       => $r['record_id'] !== null,
            'total_cost_sec' => $r['total_cost_sec'] === null ? null : (int)$r['total_cost_sec'],
            'loop_total'   => (int)$r['loop_total'],
            'ending_id'    => $r['end_ending_id'] === null ? null : (int)$r['end_ending_id'],
            'record_id'    => $r['record_id'],
        );
    }
    json_ok(array('rank' => $rank));
}

/** GET /api/class/studentDetail  {record_id|student_id} → 完整轨迹（仅限本教师班级里的学生） */
function class_studentDetail()
{
    $tid = check_teacher_auth();
    $rid = (string)req_param('record_id');
    if ($rid === '') {
        $sid = (string)req_param('student_id');
        if ($sid === '') json_fail(400, '缺少 record_id 或 student_id');
        $st = db()->prepare('SELECT record_id FROM game_sessions WHERE student_id = ? ORDER BY start_time DESC LIMIT 1');
        $st->execute(array($sid));
        $row = $st->fetch();
        if (!$row) json_fail(404, '该学生暂无游戏记录');
        $rid = $row['record_id'];
    }
    need_record($rid);
    /* 越权保护：记录里的学生必须在本教师的某个班级里 */
    if (!teacher_owns_record($tid, $rid)) {
        json_fail(403, '该学生不在你的班级中');
    }

    $pdo = db();
    $sess = $pdo->prepare(
        'SELECT g.*, s.student_name, s.class_name, s.phone FROM game_sessions g
         JOIN students s ON s.student_id = g.student_id WHERE g.record_id = ?'
    );
    $sess->execute(array($rid));
    $session = $sess->fetch();

    /* 新旧库兼容：老库没有 node_title / choice_text，就只返回编号，前端用内置名称表补齐 */
    $hasText = table_has_column('game_node_trace', 'choice_text');
    $traceSql = $hasText
        ? 'SELECT node_id, choice_id, node_title, choice_text, enter_time FROM game_node_trace WHERE record_id = ? ORDER BY enter_time, trace_id'
        : 'SELECT node_id, choice_id, enter_time FROM game_node_trace WHERE record_id = ? ORDER BY enter_time, trace_id';
    $tr = $pdo->prepare($traceSql);
    $tr->execute(array($rid));
    $trace = $tr->fetchAll();

    $lp = $pdo->prepare('SELECT loop_node_id, enter_count, last_enter_time FROM game_loop_record WHERE record_id = ? ORDER BY enter_count DESC');
    $lp->execute(array($rid));
    $loops = $lp->fetchAll();

    $qt = $pdo->prepare('SELECT qte_name, qte_type, is_success, cost_ms, attempt_count, occur_time FROM game_qte_record WHERE record_id = ? ORDER BY occur_time');
    $qt->execute(array($rid));
    $qtes = $qt->fetchAll();

    $ed = $pdo->prepare('SELECT ending_id, ending_type, occur_time FROM game_ending_record WHERE record_id = ? ORDER BY occur_time');
    $ed->execute(array($rid));
    $endings = $ed->fetchAll();

    json_ok(array('session' => $session, 'trace' => $trace, 'loops' => $loops, 'qtes' => $qtes, 'endings' => $endings));
}

/** GET /api/class/export  {class_id, with_phone=0|1} — 导出排行榜 CSV（UTF-8 BOM，Excel 直开） */
function class_export()
{
    $tid = check_teacher_auth();
    $cid = (string)req_param('class_id');
    $withPhone = (int)req_param('with_phone') === 1;   // 隐私开关：默认不导出手机号

    $st = db()->prepare('SELECT class_name FROM classes WHERE class_id = ? AND teacher_id = ?');
    $st->execute(array($cid, $tid));
    $cls = $st->fetch();
    if (!$cls) json_fail(404, '班级不存在');

    $list = class_best_records($cid);
    $filename = '排名_' . preg_replace('/[\\\\\/\:\*\?"<>\|\s]/', '_', $cls['class_name']) . '_' . date('Ymd_Hi') . '.csv';

    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . rawurlencode($filename) . '"');
    $out = fopen('php://output', 'w');
    fwrite($out, "\xEF\xBB\xBF");   // BOM：Excel 直接打开不乱码
    $head = array('排名', '学生姓名');
    if ($withPhone) $head[] = '手机号';
    $head = array_merge($head, array('所在班级', '通关状态', '主题', '总耗时(秒)', '死循环总次数', '结局编号', '奖励(小红花)', '最近游戏时间'));
    fputcsv($out, $head);

    $no = 0;
    foreach ($list as $r) {
        $no++;
        $row = array($no, $r['student_name']);
        if ($withPhone) $row[] = $r['phone'];
        $row = array_merge($row, array(
            $cls['class_name'],
            $r['is_complete'] === null ? '未开始' : ((int)$r['is_complete'] ? '已通关' : '未通关'),
            isset($r['theme']) ? $r['theme'] : '',
            $r['total_cost_sec'] === null ? '' : $r['total_cost_sec'],
            (int)$r['loop_total'],
            $r['end_ending_id'] === null ? '' : $r['end_ending_id'],
            /* 奖励：第 1 名 10 朵、第 2 名 9 朵……第 10 名 1 朵，10 名之后无 */
            $no <= 10 ? (11 - $no) : 0,
            $r['end_time'] ? $r['end_time'] : ($r['start_time'] ? ($r['start_time'] . '(进行中)') : ''),
        ));
        fputcsv($out, $row);
    }
    fclose($out);
    exit;
}

/** GET /api/teacher/overview → 我的所有班级汇总（个人排行大屏）
 *  只统计当前登录教师名下的班级，天然与其他教师隔离。 */
function teacher_overview()
{
    $tid = check_teacher_auth();
    $st = db()->prepare('SELECT class_id, class_name FROM classes WHERE teacher_id = ? ORDER BY create_time ASC');
    $st->execute(array($tid));
    $classes = $st->fetchAll();

    $clsRows = array();
    $best = array();      // student_id => 最优记录（跨班去重，同一人只出现一次）
    $flowerTotal = 0;

    foreach ($classes as $c) {
        $list = class_best_records($c['class_id']);
        $done = 0;
        $secs = array();
        $no = 0;
        foreach ($list as $r) {
            $no++;
            if ($no <= 10) $flowerTotal += (11 - $no);
            if ((int)$r['is_complete'] === 1) $done++;
            if ($r['total_cost_sec'] !== null) $secs[] = (int)$r['total_cost_sec'];

            $sid = $r['student_id'];
            $r['class_name'] = $c['class_name'];
            if (!isset($best[$sid]) || self_better($r, $best[$sid])) {
                $best[$sid] = $r;
            }
        }
        $cnt = count($list);
        $clsRows[] = array(
            'class_id'      => $c['class_id'],
            'class_name'    => $c['class_name'],
            'student_count' => $cnt,
            'done'          => $done,
            'rate'          => $cnt ? (int)round($done * 100 / $cnt) : 0,
            'avg_cost_sec'  => $secs ? (int)round(array_sum($secs) / count($secs)) : null,
            'flowers'       => self_flowers(count($list)),
        );
    }

    /* 全体学生总榜（按最优成绩排序，最多 50 条） */
    $all = array_values($best);
    usort($all, 'self_cmp');
    $top = array();
    $no = 0;
    $doneAll = 0;
    $secsAll = array();
    foreach ($all as $r) {
        if ((int)$r['is_complete'] === 1) $doneAll++;
        if ($r['total_cost_sec'] !== null) $secsAll[] = (int)$r['total_cost_sec'];
    }
    foreach (array_slice($all, 0, 50) as $r) {
        $no++;
        $top[] = array(
            'rank'           => $no,
            'student_id'     => $r['student_id'],
            'student_name'   => $r['student_name'],
            'class_name'     => $r['class_name'],
            'is_complete'    => $r['is_complete'] === null ? null : (int)$r['is_complete'],
            'theme'          => isset($r['theme']) ? $r['theme'] : '',
            'total_cost_sec' => $r['total_cost_sec'] === null ? null : (int)$r['total_cost_sec'],
            'loop_total'     => (int)$r['loop_total'],
            'ending_id'      => $r['end_ending_id'] === null ? null : (int)$r['end_ending_id'],
            'record_id'      => $r['record_id'],
        );
    }

    $total = count($all);
    json_ok(array(
        'summary' => array(
            'class_count'   => count($classes),
            'student_count' => $total,
            'done'          => $doneAll,
            'rate'          => $total ? (int)round($doneAll * 100 / $total) : 0,
            'avg_cost_sec'  => $secsAll ? (int)round(array_sum($secsAll) / count($secsAll)) : null,
            'flowers'       => $flowerTotal,
        ),
        'classes' => $clsRows,
        'top'     => $top,
    ));
}

/** 一个班级（按当前排名）共发出多少朵小红花：第 1 名 10 朵 …… 第 10 名 1 朵 */
function self_flowers($count)
{
    $sum = 0;
    for ($i = 1; $i <= $count && $i <= 10; $i++) {
        $sum += (11 - $i);
    }
    return $sum;
}
