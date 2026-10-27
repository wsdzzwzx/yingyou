<?php
/**
 * api/student.php — 学生端：身份录入与会话创建
 */

/** POST /api/student/saveInfo  {class_name, name, phone} → {student_id} */
function student_saveInfo()
{
    req_need(array('class_name', 'name'));
    $className = mb_substr((string)req_param('class_name'), 0, 50);
    $name      = mb_substr((string)req_param('name'), 0, 50);
    $phone     = preg_match('/^1\d{10}$/', (string)req_param('phone')) ? req_param('phone') : '';

    $pdo = db();
    // 同班同名视为同一学生：存在则回填手机号并复用 student_id（支持再次进入修改资料）
    $st = $pdo->prepare('SELECT student_id FROM students WHERE class_name = ? AND student_name = ? LIMIT 1');
    $st->execute(array($className, $name));
    $row = $st->fetch();

    if ($row) {
        $sid = $row['student_id'];
        $upd = $pdo->prepare('UPDATE students SET phone = ? WHERE student_id = ?');
        $upd->execute(array($phone, $sid));
    } else {
        $sid = biz_id('s');
        $ins = $pdo->prepare('INSERT INTO students (student_id, class_name, student_name, phone, create_time) VALUES (?,?,?,?,NOW())');
        $ins->execute(array($sid, $className, $name, $phone));
    }
    json_ok(array('student_id' => $sid));
}
