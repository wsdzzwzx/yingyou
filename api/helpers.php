<?php
/**
 * api/helpers.php — 请求解析与共享工具（由 index.php 引入）
 */

/** 读取请求体 JSON（兼容 fetch 的 application/json 与 sendBeacon 的 text/plain） */
function req_body()
{
    static $body = null;
    if ($body === null) {
        $raw = file_get_contents('php://input');
        $body = array();
        if ($raw !== '' && $raw !== false) {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) $body = $decoded;
        }
        if (!$body) $body = $_POST;   // 兜底表单
    }
    return $body;
}

/** 取 body / query 字段（去空格），不存在返回默认值 */
function req_param($key, $default = null)
{
    $body = req_body();
    if (isset($body[$key])) return is_string($body[$key]) ? trim($body[$key]) : $body[$key];
    if (isset($_GET[$key])) return is_string($_GET[$key]) ? trim($_GET[$key]) : $_GET[$key];
    return $default;
}

/** 必填字段校验 */
function req_need($keys)
{
    foreach ($keys as $k) {
        $v = req_param($k);
        if ($v === null || $v === '') json_fail(400, '缺少必填参数: ' . $k);
    }
}

/** 校验会话存在并返回其 student_id */
function need_record($recordId)
{
    $st = db()->prepare('SELECT record_id, student_id, start_time FROM game_sessions WHERE record_id = ?');
    $st->execute(array($recordId));
    $row = $st->fetch();
    if (!$row) json_fail(404, '游戏会话不存在');
    return $row;
}

/* ============================================================
   密码复杂度校验
   ------------------------------------------------------------
   规则：至少 6 位，且必须同时包含「字母 + 数字 + @」。
   通过返回空字符串；不通过返回可直接展示给用户的原因。
   ============================================================ */

/** 返回 '' 表示通过；否则返回不通过的具体原因 */
function password_rule_error($pwd)
{
    $pwd = (string)$pwd;
    if (strlen($pwd) < 6) {
        return '密码至少 6 位（要求：字母 + 数字 + @）';
    }
    $miss = array();
    if (!preg_match('/[A-Za-z]/', $pwd)) $miss[] = '字母';
    if (!preg_match('/[0-9]/', $pwd))    $miss[] = '数字';
    if (strpos($pwd, '@') === false)     $miss[] = '@';
    if (!empty($miss)) {
        return '密码必须同时包含字母、数字和 @，当前缺少：' . implode('、', $miss);
    }
    return '';
}

/** 校验不通过直接返回 400；$label 用于区分「初始密码 / 新密码」 */
function require_strong_password($pwd, $label = '密码')
{
    $err = password_rule_error($pwd);
    if ($err !== '') json_fail(400, $label . '：' . $err);
}

/* ============================================================
   旧版 config.php 兼容层
   ------------------------------------------------------------
   下面的函数正常由 config.php 提供。但升级时如果只覆盖了
   api/ 却没覆盖 config.php（老版本没有这几个函数），调用会直接
   Fatal error —— 表现为「登录没反应」「看不到教师管理入口」。
   这里做一次存在性兜底：已定义则跳过，未定义就地补等价实现。
   加载顺序：config.php → api/helpers.php → api/*.php，所以
   helpers.php 里补的定义对后面所有业务文件都生效。
   ============================================================ */

if (!function_exists('table_has_column')) {
    /** 判断表里是否有某个字段（新旧库平滑兼容） */
    function table_has_column($table, $column)
    {
        static $cache = array();
        $key = $table . '.' . $column;
        if (array_key_exists($key, $cache)) return $cache[$key];
        $cache[$key] = false;
        try {
            $st = db()->query('SHOW COLUMNS FROM `' . str_replace('`', '', $table) . '`');
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
                if (isset($row['Field']) && strcasecmp($row['Field'], $column) === 0) {
                    $cache[$key] = true;
                    break;
                }
            }
        } catch (Exception $e) {
            $cache[$key] = false;
        }
        return $cache[$key];
    }
}

if (!function_exists('teacher_is_admin')) {
    /**
     * 教师是否管理员。老库没有 is_admin 字段时按「最早创建的教师」兜底，
     * 保证升级过程中始终有人能进教师管理页。
     */
    function teacher_is_admin($teacherId)
    {
        if (table_has_column('teachers', 'is_admin')) {
            $st = db()->prepare('SELECT is_admin FROM teachers WHERE teacher_id = ?');
            $st->execute(array($teacherId));
            $row = $st->fetch();
            return $row && (int)$row['is_admin'] === 1;
        }
        $st = db()->prepare('SELECT teacher_id FROM teachers ORDER BY create_time ASC, teacher_id ASC LIMIT 1');
        $st->execute();
        $first = $st->fetch();
        return $first && $first['teacher_id'] === $teacherId;
    }
}

if (!function_exists('check_teacher_admin')) {
    /** 要求当前登录者是管理员，返回其 teacher_id */
    function check_teacher_admin()
    {
        $tid = check_teacher_auth();
        if (!teacher_is_admin($tid)) {
            json_fail(403, '只有管理员可以管理教师账号');
        }
        return $tid;
    }
}

if (!function_exists('teacher_owns_record')) {
    /** 该游戏会话是否属于此教师（其学生须在本教师某个班级里） */
    function teacher_owns_record($teacherId, $recordId)
    {
        $st = db()->prepare(
            'SELECT 1 FROM game_sessions g
             JOIN class_student_rel r ON r.student_id = g.student_id
             JOIN classes c ON c.class_id = r.class_id
             WHERE g.record_id = ? AND c.teacher_id = ? LIMIT 1'
        );
        $st->execute(array($recordId, $teacherId));
        return (bool)$st->fetch();
    }
}
