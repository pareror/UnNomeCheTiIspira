import torch

from acoustic_models.teacher import TeacherSoftLabels


def test_mapping_projects_teacher_scores():
    groups = {"a": [0, 1], "b": [2]}
    teacher = TeacherSoftLabels.from_dict(groups, n_teacher=3, class_names=["a", "b"])

    scores = torch.tensor([[0.5, 0.5, 0.0], [0.0, 0.0, 1.0]])
    soft = teacher(scores)

    assert soft.shape == (2, 2)
    # teacher mass in group "a" lands in student class "a"
    assert soft[0, 0] > soft[0, 1]
    assert soft[1, 1] > soft[1, 0]
